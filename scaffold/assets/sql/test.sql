-- Example SQL file for Snowflake
SELECT 
    'Runnerty Snowflake Test' as test_name,
    CURRENT_TIMESTAMP() as execution_time,
    CURRENT_USER() as executed_by,
    CURRENT_DATABASE() as database_name,
    CURRENT_SCHEMA() as schema_name;

-- Generate some sample data
SELECT 
    seq4() as row_number,
    UNIFORM(1, 100, RANDOM()) as random_number,
    TO_CHAR(DATEADD(day, seq4(), CURRENT_DATE()), 'YYYY-MM-DD') as future_date
FROM TABLE(GENERATOR(ROWCOUNT => 3));