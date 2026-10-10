-- Read-only role for the public API (Vercel). The pipeline keeps using the owner role.
-- Run once as the database owner, replacing the password:
--   psql "$DATABASE_URL" -v pw="'<strong-random-password>'" -f db/reader-role.sql
-- Then set Vercel's DATABASE_URL to postgresql://api_reader:<password>@<pooled-host>/neondb?sslmode=require
create role api_reader with login password :pw;
grant connect on database neondb to api_reader;
grant usage on schema public to api_reader;
grant select on all tables in schema public to api_reader;
alter default privileges in schema public grant select on tables to api_reader;
alter role api_reader set default_transaction_read_only = on;
