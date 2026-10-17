-- Continuous aggregates for charts (5 min / 1 h / 1 day). Idempotent; must run OUTSIDE a transaction.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_5m WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, cabinet_id,
  avg(v_l1) AS v_l1, avg(v_l2) AS v_l2, avg(v_l3) AS v_l3,
  min(least(v_l1, v_l2, v_l3)) AS v_min, max(greatest(v_l1, v_l2, v_l3)) AS v_max,
  avg(i_l1) AS i_l1, avg(i_l2) AS i_l2, avg(i_l3) AS i_l3,
  avg(p_total_kw) AS p_total_kw, avg(pf_total) AS pf_total,
  max(leak_ma) AS leak_ma_max, avg(temp_c) AS temp_c,
  bool_or(branch1_on) AS branch1_on, bool_or(branch2_on) AS branch2_on,
  count(*) AS samples
FROM telemetry GROUP BY bucket, cabinet_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_5m', start_offset => INTERVAL '1 day', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1h WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket, cabinet_id,
  avg(v_l1) AS v_l1, avg(v_l2) AS v_l2, avg(v_l3) AS v_l3, min(v_min) AS v_min, max(v_max) AS v_max,
  avg(i_l1) AS i_l1, avg(i_l2) AS i_l2, avg(i_l3) AS i_l3,
  avg(p_total_kw) AS p_total_kw, avg(pf_total) AS pf_total,
  -- energy estimate until the firmware sends kWh counters: avg kW x hours lit
  sum(p_total_kw * samples) / NULLIF(sum(samples), 0) AS kwh_estimate,
  max(leak_ma_max) AS leak_ma_max, avg(temp_c) AS temp_c,
  sum(samples) AS samples
FROM telemetry_5m GROUP BY 1, cabinet_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1h', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1d WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', bucket, 'Asia/Ho_Chi_Minh') AS bucket, cabinet_id,
  min(v_min) AS v_min, max(v_max) AS v_max, avg(p_total_kw) AS p_total_kw,
  sum(kwh_estimate) AS kwh_estimate, max(leak_ma_max) AS leak_ma_max, max(temp_c) AS temp_c_max
FROM telemetry_1h GROUP BY 1, cabinet_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1d', start_offset => INTERVAL '10 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '6 hours', if_not_exists => TRUE);
