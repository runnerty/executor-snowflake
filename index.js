'use strict';

const snowflake = require('snowflake-sdk');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const JSONStream = require('jsonstream');
const Excel = require('exceljs');
const csv = require('fast-csv');
const { getToken } = require('./get-token');

const Executor = require('@runnerty/module-core').Executor;

// Snowflake GS error code returned when the cached ID token is expired or invalid
const ID_TOKEN_INVALID_CODE = '390195';

// Shared between all the processes of a Runnerty execution: when the cached ID token
// expires every process fails at once, and each one of them would open its own browser
// authentication. Only the first one authenticates, the rest wait for it and then reuse
// the newly cached token.
let pendingReauthentication = null;

class snowflakeExecutor extends Executor {
  constructor(process) {
    super(process);
    this.ended = false;
    this.endOptions = {
      end: 'end'
    };
  }

  async exec(params) {
    try {
      // Cargar comando SQL
      if (!params.command) {
        if (params.command_file) {
          try {
            await fsp.access(params.command_file, fs.constants.F_OK | fs.constants.W_OK);
            params.command = await fsp.readFile(params.command_file, 'utf8');
          } catch (err) {
            throw new Error(`Load SQLFile: ${err}`);
          }
        } else {
          this.endOptions.end = 'error';
          this.endOptions.messageLog = 'execute-snowflake dont have command or command_file';
          this.endOptions.err_output = 'execute-snowflake dont have command or command_file';
          this._end(this.endOptions);
          return;
        }
      }

      const query = await this.prepareQuery(params);
      this.endOptions.command_executed = query;

      // Crear conexión y ejecutar consulta
      const connection = await this.createConnection(params);

      // Verificar parámetros de exportación y ejecutar el método correspondiente
      if (params.fileExport) await this.queryToJSON(connection, query, params);
      if (params.jsonFileExport) await this.queryToJSON(connection, query, params);
      else if (params.xlsxFileExport) await this.queryToXLSX(connection, query, params);
      else if (params.csvFileExport) await this.queryToCSV(connection, query, params);
      else await this.executeQuery(connection, query);
    } catch (error) {
      this.error(error);
    }
  }

  async createConnection(params) {
    const useExternalBrowser = (params.authenticator || '').toLowerCase() === 'externalbrowser';

    let token = null;
    if (!useExternalBrowser) {
      // The external browser (SSO) flow does not use the OAuth token endpoint
      try {
        token = await getToken(params);
      } catch (error) {
        throw new Error(`Failed to get token or connect: ${error.message}`);
      }
    }

    const connectionOptions = this.getConnectionOptions(params, token);

    try {
      return await this.connect(connectionOptions, useExternalBrowser);
    } catch (error) {
      // With external browser auth the ID token is cached to avoid opening the browser on
      // every connection. Once it expires the driver keeps sending it instead of starting a
      // new authentication, so every process fails. Drop the cached token and authenticate
      // again through the browser.
      if (!useExternalBrowser || !this.isInvalidIdTokenError(error)) throw error;

      // Another process is already re-authenticating: wait for it and reuse its token
      // instead of opening a second browser.
      if (pendingReauthentication) {
        await pendingReauthentication;
        return this.connect(connectionOptions, useExternalBrowser);
      }

      if (!(await this.removeCachedIdToken(connectionOptions))) throw error;

      this.warn('The cached SSO ID token has expired. Removed it and re-authenticating through the browser...');

      pendingReauthentication = this.connect(connectionOptions, useExternalBrowser);
      try {
        return await pendingReauthentication;
      } catch (reauthError) {
        // Let a later attempt start a new authentication
        pendingReauthentication = null;
        throw reauthError;
      }
    }
  }

  connect(connectionOptions, useExternalBrowser) {
    return new Promise((resolve, reject) => {
      const connection = snowflake.createConnection(connectionOptions);

      const connectCallback = (err, conn) => {
        if (err) {
          const error = new Error(`Snowflake connection error: ${err.message}`);
          // Keep the original error so the caller can identify an expired ID token
          error.code = err.code;
          error.cause = err;
          reject(error);
        } else {
          resolve(conn);
        }
      };

      // External browser (SSO) authentication is asynchronous: it must use connectAsync
      if (useExternalBrowser) {
        connection.connectAsync(connectCallback);
      } else {
        connection.connect(connectCallback);
      }
    });
  }

  isInvalidIdTokenError(error) {
    if (!error) return false;
    if (String(error.code) === ID_TOKEN_INVALID_CODE) return true;
    return /id[ _]token is invalid|id_token_invalid/i.test(String(error.message || ''));
  }

  async removeCachedIdToken(connectionOptions) {
    try {
      // Required lazily: these are snowflake-sdk internals and should never prevent the
      // executor from loading if they move in a future version of the driver.
      const GlobalConfig = require('snowflake-sdk/lib/global_config');
      const SnowflakeUtil = require('snowflake-sdk/lib/util');
      const AuthenticationTypes = require('snowflake-sdk/lib/authentication/authentication_types');
      const JsonCredentialManager = require('snowflake-sdk/lib/authentication/secure_storage/json_credential_manager');

      // The driver resolves the final host while building the connection, so connectionOptions
      // already holds the same host used to build the credential cache key.
      const key = SnowflakeUtil.buildCredentialCacheKey(
        connectionOptions.host,
        connectionOptions.username,
        AuthenticationTypes.ID_TOKEN_AUTHENTICATOR
      );
      if (!key) return false;

      let credentialManager = GlobalConfig.getCredentialManager();
      if (!credentialManager) {
        credentialManager = new JsonCredentialManager();
        GlobalConfig.setCustomCredentialManager(credentialManager);
      }

      await credentialManager.remove(key);
      return true;
    } catch (err) {
      this.warn(`Could not remove the cached SSO ID token: ${err.message}`);
      return false;
    }
  }

  warn(message) {
    const text = `execute-snowflake: ${message}`;
    if (this.logger && typeof this.logger.log === 'function') {
      this.logger.log('warn', text);
    } else {
      console.warn(`⚠️  ${text}`);
    }
  }

  getConnectionOptions(params, token) {
    const options = {
      account: params.account,
      username: params.user,
      database: params.database,
      schema: params.schema,
      warehouse: params.warehouse,
      role: params.role,
      timeout: params.timeout || 60000,
      application: params.application || 'runnerty'
    };

    if ((params.authenticator || '').toLowerCase() === 'externalbrowser') {
      // Browser-based SSO (opens the default browser to authenticate against the IdP).
      // clientStoreTemporaryCredential caches the token so the browser is opened only
      // once and reused across processes.
      options.authenticator = 'EXTERNALBROWSER';
      if (params.host) options.host = params.host;
      options.clientStoreTemporaryCredential = params.clientStoreTemporaryCredential !== false;
      if (params.browserActionTimeout) options.browserActionTimeout = params.browserActionTimeout;
    } else {
      options.authenticator = 'oauth'; // OAuth token obtained from the token endpoint
      options.token = token;
    }

    return options;
  }

  async executeQuery(connection, query) {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText: query,
        streamResult: true,
        complete: (err, stmt, rows) => {
          if (err) {
            reject(err);
            return;
          }

          // Procesar resultados con streaming si está disponible
          if (stmt.streamRows) {
            const results = [];
            let firstRow = {};
            let rowCounter = 0;
            const stream = stmt.streamRows();

            stream.on('data', row => {
              if (rowCounter === 0) firstRow = row;
              results.push(row);
              rowCounter++;
            });

            stream.on('end', () => {
              this.prepareEndOptions(firstRow, rowCounter, results);
              this._end(this.endOptions);
              connection.destroy();
              resolve();
            });

            stream.on('error', error => {
              reject(error);
            });
          } else {
            // Fallback sin streaming
            this.prepareEndOptions(rows[0], rows ? rows.length : 0, rows);
            this._end(this.endOptions);
            connection.destroy();
            resolve();
          }
        }
      });
    });
  }

  error(err, connection) {
    console.error('❌ Snowflake Error:', err.message || err);
    this.endOptions.end = 'error';
    this.endOptions.messageLog = `execute-snowflake: ${err.message || err}`;
    this.endOptions.err_output = `execute-snowflake: ${err.message || err}`;
    if (connection) connection.destroy();
    this._end(this.endOptions);
  }

  _end(endOptions) {
    if (!this.ended) {
      this.ended = true;
      super.end(endOptions);
    }
  }

  async prepareQuery(values) {
    let query = values.command;

    // Reemplazar argumentos en la consulta
    if (values.args) {
      for (const key in values.args) {
        const regex = new RegExp(`:${key}`, 'g');
        query = query.replace(regex, values.args[key]);
      }
    }

    return query;
  }

  prepareEndOptions(firstRow, rowCounter, results) {
    this.endOptions.data_output = results || [];
    this.endOptions.extra_output = {
      db_countrows: rowCounter || 0,
      db_firstrow: firstRow || {}
    };

    // Variables globales para Runnerty
    if (firstRow) {
      Object.keys(firstRow).forEach(key => {
        this.endOptions[`db_firstrow_${key.toLowerCase()}`] = firstRow[key];
      });
    }
  }

  async queryToJSON(connection, query, params) {
    try {
      // Verificar que el directorio del archivo de exportación existe
      await fsp.access(path.dirname(params.jsonFileExport));

      const fileStreamWriter = fs.createWriteStream(params.jsonFileExport);

      fileStreamWriter.on('error', error => {
        this.error(error, connection);
      });

      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: query,
          streamResult: true,
          complete: (err, stmt, rows) => {
            if (err) {
              reject(err);
              return;
            }

            // Usar streaming si está disponible
            if (stmt.streamRows) {
              let firstRow = {};
              let rowCounter = 0;
              let isFirstRow = true;
              const stream = stmt.streamRows();

              stream.on('data', row => {
                if (isFirstRow) {
                  firstRow = row;
                  isFirstRow = false;
                }
                rowCounter++;
              });

              stream.on('end', () => {
                this.prepareEndOptions(firstRow, rowCounter);
                this._end(this.endOptions);
                connection.destroy();
                resolve();
              });

              stream.on('error', error => {
                this.error(error, connection);
                reject(error);
              });

              // Pipe los datos a JSON y luego al archivo
              stream.pipe(JSONStream.stringify()).pipe(fileStreamWriter);
            } else {
              // Fallback sin streaming - escribir directamente los rows
              fileStreamWriter.write(JSON.stringify(rows, null, 2));
              fileStreamWriter.end();

              fileStreamWriter.on('finish', () => {
                this.prepareEndOptions(rows[0], rows ? rows.length : 0);
                this._end(this.endOptions);
                connection.destroy();
                resolve();
              });
            }
          }
        });
      });
    } catch (err) {
      this.error(err, connection);
    }
  }

  async queryToXLSX(connection, query, params) {
    try {
      // Verificar que el directorio del archivo de exportación existe
      await fsp.access(path.dirname(params.xlsxFileExport));

      const fileStreamWriter = fs.createWriteStream(params.xlsxFileExport);

      const options = {
        stream: fileStreamWriter,
        useStyles: true,
        useSharedStrings: true
      };
      const workbook = new Excel.stream.xlsx.WorkbookWriter(options);

      const author = 'Runnerty';
      const sheetName = 'Sheet';
      const sheet = workbook.addWorksheet(params.xlsxSheetName ? params.xlsxSheetName : sheetName);
      workbook.creator = params.xlsxAuthorName ? params.xlsxAuthorName : author;
      workbook.lastPrinted = new Date();

      fileStreamWriter.on('error', error => {
        this.error(error, connection);
      });

      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: query,
          streamResult: true,
          complete: (err, stmt, rows) => {
            if (err) {
              reject(err);
              return;
            }

            // Usar streaming si está disponible
            if (stmt.streamRows) {
              let firstRow = {};
              let rowCounter = 0;
              let isFirstRow = true;
              const stream = stmt.streamRows();

              stream.on('data', row => {
                if (isFirstRow) {
                  firstRow = row;
                  sheet.columns = this.generateHeader(row);
                  isFirstRow = false;
                }
                sheet.addRow(row).commit();
                rowCounter++;
              });

              stream.on('end', async () => {
                try {
                  await workbook.commit();
                  this.prepareEndOptions(firstRow, rowCounter);
                  this._end(this.endOptions);
                  connection.destroy();
                  resolve();
                } catch (commitError) {
                  this.error(commitError, connection);
                  reject(commitError);
                }
              });

              stream.on('error', error => {
                this.error(error, connection);
                reject(error);
              });
            } else {
              // Fallback sin streaming
              try {
                if (rows && rows.length > 0) {
                  sheet.columns = this.generateHeader(rows[0]);
                  rows.forEach(row => {
                    sheet.addRow(row).commit();
                  });
                }

                workbook
                  .commit()
                  .then(() => {
                    this.prepareEndOptions(rows[0], rows ? rows.length : 0);
                    this._end(this.endOptions);
                    connection.destroy();
                    resolve();
                  })
                  .catch(commitError => {
                    this.error(commitError, connection);
                    reject(commitError);
                  });
              } catch (fallbackError) {
                this.error(fallbackError, connection);
                reject(fallbackError);
              }
            }
          }
        });
      });
    } catch (err) {
      this.error(err, connection);
    }
  }

  async queryToCSV(connection, query, params) {
    try {
      // Verificar que el directorio del archivo de exportación existe
      await fsp.access(path.dirname(params.csvFileExport));

      const fileStreamWriter = fs.createWriteStream(params.csvFileExport);

      const paramsCSV = params.csvOptions || {};
      if (!paramsCSV.hasOwnProperty('headers')) paramsCSV.headers = true;

      const csvStream = csv.format(paramsCSV).on('error', err => {
        this.error(err, connection);
      });

      fileStreamWriter.on('error', error => {
        this.error(error, connection);
      });

      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: query,
          streamResult: true,
          complete: (err, stmt, rows) => {
            if (err) {
              reject(err);
              return;
            }

            // Usar streaming si está disponible
            if (stmt.streamRows) {
              let firstRow = {};
              let rowCounter = 0;
              let isFirstRow = true;
              const stream = stmt.streamRows();

              stream.on('data', row => {
                if (isFirstRow) {
                  firstRow = row;
                  isFirstRow = false;
                }
                rowCounter++;
              });

              stream.on('end', () => {
                this.prepareEndOptions(firstRow, rowCounter);
                this._end(this.endOptions);
                connection.destroy();
                resolve();
              });

              stream.on('error', error => {
                this.error(error, connection);
                reject(error);
              });

              // Pipe los datos a CSV y luego al archivo
              stream.pipe(csvStream).pipe(fileStreamWriter);
            } else {
              // Fallback sin streaming
              try {
                if (rows && rows.length > 0) {
                  rows.forEach(row => {
                    csvStream.write(row);
                  });
                }
                csvStream.end();

                csvStream.on('finish', () => {
                  this.prepareEndOptions(rows[0], rows ? rows.length : 0);
                  this._end(this.endOptions);
                  connection.destroy();
                  resolve();
                });
              } catch (fallbackError) {
                this.error(fallbackError, connection);
                reject(fallbackError);
              }
            }
          }
        });
      });
    } catch (err) {
      this.error(err, connection);
    }
  }

  generateHeader(row) {
    const headers = [];
    Object.keys(row).forEach(key => {
      headers.push({
        header: key,
        key: key,
        width: 20
      });
    });
    return headers;
  }
}

module.exports = snowflakeExecutor;
