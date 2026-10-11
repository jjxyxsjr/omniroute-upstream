-- 200_fork_call_logs_error_raw_head.sql
--
-- nnd fork (#93, deploy/docs/157 §六-1 / 155 §二十二): call_logs.error_raw_head —
-- wire-form head (first 512 chars, escape forms preserved, captured at
-- providerFailure before any JSON.parse restoration) of the error response.
-- Root cure for the max_tokens \u003c case where error_summary truncation plus
-- parse restoration obscured the wire form for two days. NULL for success rows
-- and rows written before this migration.
ALTER TABLE call_logs ADD COLUMN error_raw_head TEXT;
