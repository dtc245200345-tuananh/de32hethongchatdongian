\set ON_ERROR_STOP on
\set runtime_password `cat /run/secrets/app_runtime_password`

SELECT format(
  'CREATE ROLE chat_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_runtime') \gexec

SELECT format(
  'ALTER ROLE chat_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_password'
) \gexec

GRANT CONNECT ON DATABASE chatdb TO chat_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO chat_runtime;

DO $$
DECLARE
  object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY['users', 'messages', 'rooms', 'room_members', 'session']
  LOOP
    IF to_regclass(format('%I.%I', 'public', object_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I OWNER TO chat_runtime', 'public', object_name);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  sequence_name regclass;
BEGIN
  FOR sequence_name IN
    SELECT pg_get_serial_sequence(format('%I.%I', 'public', table_name), 'id')::regclass
    FROM unnest(ARRAY['users', 'messages']) AS table_name
    WHERE pg_get_serial_sequence(format('%I.%I', 'public', table_name), 'id') IS NOT NULL
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO chat_runtime', sequence_name);
  END LOOP;
END
$$;
