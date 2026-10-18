-- ingest wrote cabinet_state.extra as JSON.stringify(...) through postgres.js, which stored a JSON *string*
-- ("{}") instead of an object (since M1). Fixed in the ingest worker (M8); repair the rows already written.
UPDATE "cabinet_state" SET "extra" = ("extra" #>> '{}')::jsonb WHERE jsonb_typeof("extra") = 'string';
