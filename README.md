<p align="center">
  <a href="http://runnerty.io">
    <img height="257" src="https://runnerty.io/assets/header/logo-stroked.png">
  </a>
  <p align="center">Smart Processes Management</p>
</p>

[![NPM version][npm-image]][npm-url] [![Downloads][downloads-image]][npm-url]
<a href="#badge">
<img alt="code style: prettier" src="https://img.shields.io/badge/code_style-prettier-ff69b4.svg">
</a>

# Snowflake executor for [Runnerty]:

### Installation:

Through NPM

```bash
npm i @runnerty/executor-snowflake
```

You can also add modules to your project with [runnerty-cli]

```bash
npx runnerty-cli add @runnerty/executor-snowflake
```

This command installs the module in your project, adds example configuration in your `config.json` and creates an example plan of use.

If you have installed [runnerty-cli] globally you can include the module with this command:

```bash
rty add @runnerty/executor-snowflake
```

### Configuration:

Add in [config.json]:

#### OAuth Authentication (Recommended):

This executor uses OAuth token authentication by default. You need to configure your OAuth token provider and set the following environment variables:

```bash
export SNOWFLAKE_ACCOUNT="myaccount.us-east-1"
export SNOWFLAKE_USERNAME="myuser@company.com"
export SNOWFLAKE_PASSWORD="mypassword"
```

```json
{
  "id": "snowflake_default",
  "type": "@runnerty-executor-snowflake",
  "account": "@ENV(SNOWFLAKE_ACCOUNT)",
  "username": "@ENV(SNOWFLAKE_USERNAME)",
  "database": "@ENV(SNOWFLAKE_DATABASE)",
  "schema": "@ENV(SNOWFLAKE_SCHEMA)",
  "warehouse": "@ENV(SNOWFLAKE_WAREHOUSE)",
  "role": "@ENV(SNOWFLAKE_ROLE)"
}
```

#### Direct Configuration:

```json
{
  "id": "snowflake_default",
  "type": "@runnerty-executor-snowflake",
  "account": "myaccount.us-east-1",
  "username": "myuser@company.com",
  "database": "MYDATABASE",
  "schema": "PUBLIC",
  "warehouse": "COMPUTE_WH",
  "role": "MYROLE"
}
```

#### Configuration params:

| Parameter   | Description                                                     |
| :---------- | :-------------------------------------------------------------- |
| account     | Snowflake account identifier (e.g., "myaccount.us-east-1")      |
| username    | The Snowflake user to authenticate as.                          |
| database    | Name of the database to use for this connection. (Optional)     |
| schema      | Name of the schema to use for this connection. (Optional)       |
| warehouse   | Name of the warehouse to use for this connection. (Optional)    |
| role        | Name of the role to use for this connection. (Optional)         |
| timeout     | Connection timeout in milliseconds. (Default: 60000)            |
| application | Application name for connection tracking. (Default: "runnerty") |

### Plan samples:

Add in [plan.json]:

#### Basic query:

```json
{
  "id": "snowflake_default",
  "command_file": "./sql/my_query.sql"
}
```

```json
{
  "id": "snowflake_default",
  "command": "SELECT CURRENT_TIMESTAMP() as now, CURRENT_USER() as user"
}
```

#### Query with parameters:

```json
{
  "id": "snowflake_default",
  "command": "SELECT * FROM users WHERE created_date >= :start_date AND status = :status",
  "args": {
    "start_date": "2023-01-01",
    "status": "active"
  }
}
```

#### Export to files:

```json
{
  "id": "snowflake_default",
  "command": "SELECT * FROM sales_data WHERE year = 2023",
  "xlsxFileExport": "./reports/sales_2023.xlsx",
  "xlsxSheetName": "Sales Report",
  "xlsxAuthorName": "Data Team"
}
```

### Generation of files:

The results can be exported to csv, xlsx and json format files. These files are generated using streams for optimal performance with large datasets.
You only have to indicate the corresponding property in the parameters:

#### XLSX

XLSX Format with streaming support for large datasets.

| Parameter      | Description                   |
| :------------- | :---------------------------- |
| xlsxFileExport | Path of xlsx file export.     |
| xlsxAuthorName | Author file name. (Optional)  |
| xlsxSheetName  | Name of the sheet. (Optional) |

Sample:

```json
{
  "id": "snowflake_default",
  "command": "SELECT * FROM users",
  "xlsxFileExport": "./exports/users.xlsx",
  "xlsxAuthorName": "Runnerty",
  "xlsxSheetName": "Users Data"
}
```

#### CSV

CSV Format with streaming support and customizable options.

| Parameter               | Description                                                           |
| :---------------------- | :-------------------------------------------------------------------- |
| csvFileExport           | Path of csv file export.                                              |
| csvOptions/headers      | Type: boolean. Whether to include headers in the CSV. (Default: true) |
| csvOptions/delimiter    | Alternate delimiter. (Default: ',')                                   |
| csvOptions/quote        | Alternate quote. (Default: '"')                                       |
| csvOptions/rowDelimiter | Specify an alternate row delimiter (i.e \r\n). (Default: '\n')        |
| csvOptions/escape       | Alternate escaping value. (Default: '"')                              |

Sample:

```json
{
  "id": "snowflake_default",
  "command": "SELECT * FROM users",
  "csvFileExport": "@GV(WORK_DIR)/users.csv",
  "csvOptions": {
    "delimiter": ";",
    "quote": "\"",
    "headers": true
  }
}
```

#### JSON

JSON Format with streaming support.

| Parameter      | Description               |
| :------------- | :------------------------ |
| jsonFileExport | Path of json file export. |

Sample:

```json
{
  "id": "snowflake_default",
  "command": "SELECT * FROM users",
  "jsonFileExport": "@GV(WORK_DIR)/users.json"
}
```

### Output (Process values):

#### Standard

- `PROCESS_EXEC_MSG_OUTPUT`: Snowflake output message.
- `PROCESS_EXEC_ERR_OUTPUT`: Error output message.
- `PROCESS_EXEC_COMMAND_EXECUTED`: Executed SQL command.

#### Query output

- `PROCESS_EXEC_DATA_OUTPUT`: Snowflake query output data (array of objects).
- `PROCESS_EXEC_DB_COUNTROWS`: Snowflake query count rows.
- `PROCESS_EXEC_DB_FIRSTROW`: Snowflake query first row data (object).
- `PROCESS_EXEC_DB_FIRSTROW_[FIELD_NAME]`: Snowflake first row field data.

Example of first row field access:

```json
{
  "id": "snowflake_default",
  "command": "SELECT user_id, email, created_date FROM users LIMIT 1"
}
```

Available variables after execution:

- `PROCESS_EXEC_DB_FIRSTROW_USER_ID`: First row user_id value
- `PROCESS_EXEC_DB_FIRSTROW_EMAIL`: First row email value
- `PROCESS_EXEC_DB_FIRSTROW_CREATED_DATE`: First row created_date value

### Authentication Setup:

This executor requires OAuth authentication setup. Make sure you have:

1. **Environment variables configured:**

   ```bash
   export SNOWFLAKE_ACCOUNT="your-account"
   export SNOWFLAKE_USERNAME="your-username"
   export SNOWFLAKE_PASSWORD="your-password"
   ```

2. **OAuth token provider configured** (internal API endpoint)

3. **Required dependencies installed:**
   ```bash
   npm install snowflake-sdk axios exceljs fast-csv jsonstream
   ```

### Features:

- ✅ **OAuth Authentication** - Secure token-based authentication
- ✅ **Streaming Support** - Efficient processing of large datasets
- ✅ **Multiple Export Formats** - XLSX, CSV, JSON
- ✅ **Parameterized Queries** - Support for `:parameter` placeholders
- ✅ **Environment Variables** - Secure configuration management
- ✅ **Error Handling** - Comprehensive error reporting
- ✅ **Connection Pooling** - Optimized connection management

[runnerty]: http://www.runnerty.io
[downloads-image]: https://img.shields.io/npm/dm/@runnerty/executor-snowflake.svg
[npm-url]: https://www.npmjs.com/package/@runnerty/executor-snowflake
[npm-image]: https://img.shields.io/npm/v/@runnerty/executor-snowflake.svg
[david-badge]: https://david-dm.org/runnerty/executor-snowflake.svg
[david-badge-url]: https://david-dm.org/runnerty/executor-snowflake
[config.json]: http://docs.runnerty.io/config/
[runnerty-cli]: https://www.npmjs.com/package/runnerty-cli
[plan.json]: http://docs.runnerty.io/plan/
