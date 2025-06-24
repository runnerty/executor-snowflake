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
    try {
      const token = await getToken(params);

      const connectionOptions = this.getConnectionOptions(params, token);

      return new Promise((resolve, reject) => {
        const connection = snowflake.createConnection(connectionOptions);

        // Usar connect normal con token OAuth
        connection.connect((err, conn) => {
          if (err) {
            reject(new Error(`Snowflake connection error: ${err.message}`));
          } else {
            resolve(conn);
          }
        });
      });
    } catch (error) {
      throw new Error(`Failed to get token or connect: ${error.message}`);
    }
  }

  getConnectionOptions(params, token) {
    return {
      account: params.account,
      username: params.user,
      authenticator: 'oauth', // Especificar que usamos OAuth
      token: token, // Token OAuth obtenido de la API
      database: params.database,
      schema: params.schema,
      warehouse: params.warehouse,
      role: params.role,
      timeout: params.timeout || 60000,
      application: params.application || 'runnerty'
    };
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
