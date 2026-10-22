\set ON_ERROR_STOP on
\set exporter_password `cat /run/secrets/postgres_exporter_password`
SELECT 'CREATE ROLE chat_metrics LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_metrics') \gexec
SELECT format('ALTER ROLE chat_metrics PASSWORD %L', :'exporter_password') \gexec
GRANT CONNECT ON DATABASE chatdb TO chat_metrics;
GRANT pg_monitor TO chat_metrics;
