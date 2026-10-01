-- 197_merge_agy_into_antigravity.sql
-- The standalone `agy` provider was consolidated into `antigravity`: both clients
-- authenticate against the same Google consumer-OAuth client and share the same Cloud
-- Code backend, model catalog, and quota. Move durable provider configuration and runtime
-- state to the canonical identity, while keeping agy group allow/deny rules and per-key
-- model patterns for legacy model IDs.
-- `agy` remains a runtime alias for old URLs and `agy/<model>` IDs.

-- Existing connection credentials remain attached to their rows. Pinned default models
-- move to the canonical provider prefix at the same time.
UPDATE provider_connections
SET provider = CASE WHEN provider = 'agy' THEN 'antigravity' ELSE provider END,
    default_model = CASE
      WHEN default_model LIKE 'agy/%' THEN 'antigravity' || substr(default_model, 4)
      ELSE default_model
    END
WHERE provider = 'agy' OR default_model LIKE 'agy/%';

-- Preserve the historical provider/model rewrite performed by the original migration.
UPDATE usage_history SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE call_logs SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE registered_keys SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE quota_snapshots SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE provider_plans SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE hourly_usage_summary SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE daily_usage_summary SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE provider_quota_reset_events SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE session_model_history SET provider = 'antigravity' WHERE provider = 'agy';
UPDATE exclusive_connection_leases SET provider = 'antigravity' WHERE provider = 'agy';

-- Preserve learned per-combo provider scores and per-provider upstream routing settings.
-- Their unique provider keys are reconciled in place below so canonical rows win conflicts.
DELETE FROM combo_adaptation_state AS source
WHERE source.provider_id = 'agy'
  AND EXISTS (
    SELECT 1
    FROM combo_adaptation_state AS destination
    WHERE destination.combo_id = source.combo_id
      AND destination.provider_id = 'antigravity'
  );
UPDATE combo_adaptation_state SET provider_id = 'antigravity' WHERE provider_id = 'agy';

DELETE FROM upstream_proxy_config AS source
WHERE source.provider_id = 'agy'
  AND EXISTS (
    SELECT 1 FROM upstream_proxy_config AS destination
    WHERE destination.provider_id = 'antigravity'
  );
UPDATE upstream_proxy_config SET provider_id = 'antigravity' WHERE provider_id = 'agy';

-- Unique/composite-key tables use insert-ignore followed by source cleanup. Existing
-- antigravity rows win collisions; agy-only state is copied without losing its values.
INSERT OR IGNORE INTO provider_key_limits (
  provider,
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
)
SELECT
  'antigravity',
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
FROM provider_key_limits
WHERE provider = 'agy';
DELETE FROM provider_key_limits WHERE provider = 'agy';

INSERT OR IGNORE INTO session_account_affinity (
  session_key,
  provider,
  connection_id,
  created_at,
  last_seen_at
)
SELECT session_key, 'antigravity', connection_id, created_at, last_seen_at
FROM session_account_affinity
WHERE provider = 'agy';
DELETE FROM session_account_affinity WHERE provider = 'agy';

INSERT OR IGNORE INTO model_context_overrides (
  provider,
  model_id,
  real_context,
  source,
  refreshed_at
)
SELECT
  'antigravity',
  CASE WHEN model_id LIKE 'agy/%' THEN 'antigravity' || substr(model_id, 4) ELSE model_id END,
  real_context,
  source,
  refreshed_at
FROM model_context_overrides
WHERE provider = 'agy';
DELETE FROM model_context_overrides WHERE provider = 'agy';

INSERT OR IGNORE INTO model_capability_overrides (
  provider,
  model_id,
  override_key,
  override_value,
  refreshed_at
)
SELECT
  'antigravity',
  CASE WHEN model_id LIKE 'agy/%' THEN 'antigravity' || substr(model_id, 4) ELSE model_id END,
  override_key,
  override_value,
  refreshed_at
FROM model_capability_overrides
WHERE provider = 'agy';
DELETE FROM model_capability_overrides WHERE provider = 'agy';

INSERT OR IGNORE INTO model_capabilities (
  provider,
  model_id,
  tool_call,
  reasoning,
  attachment,
  structured_output,
  temperature,
  modalities_input,
  modalities_output,
  knowledge_cutoff,
  release_date,
  last_updated,
  status,
  family,
  open_weights,
  limit_context,
  limit_input,
  limit_output,
  interleaved_field,
  last_synced
)
SELECT
  'antigravity',
  CASE WHEN model_id LIKE 'agy/%' THEN 'antigravity' || substr(model_id, 4) ELSE model_id END,
  tool_call,
  reasoning,
  attachment,
  structured_output,
  temperature,
  modalities_input,
  modalities_output,
  knowledge_cutoff,
  release_date,
  last_updated,
  status,
  family,
  open_weights,
  limit_context,
  limit_input,
  limit_output,
  interleaved_field,
  last_synced
FROM model_capabilities
WHERE provider = 'agy';
DELETE FROM model_capabilities WHERE provider = 'agy';

INSERT OR IGNORE INTO radar_local_model_state (
  provider,
  model_id,
  display_name,
  enabled,
  tombstoned,
  updated_at
)
SELECT
  'antigravity',
  CASE WHEN model_id LIKE 'agy/%' THEN 'antigravity' || substr(model_id, 4) ELSE model_id END,
  display_name,
  enabled,
  tombstoned,
  updated_at
FROM radar_local_model_state
WHERE provider = 'agy';
DELETE FROM radar_local_model_state WHERE provider = 'agy';

INSERT OR IGNORE INTO tier_assignments (
  provider,
  model,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
)
SELECT
  'antigravity',
  CASE WHEN model LIKE 'agy/%' THEN 'antigravity' || substr(model, 4) ELSE model END,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
FROM tier_assignments
WHERE provider = 'agy';
DELETE FROM tier_assignments WHERE provider = 'agy';

-- Discovery rows have a unique provider/method/endpoint key. Delete only legacy rows that
-- collide with a canonical row, then update source-only rows in place to preserve their IDs.
DELETE FROM discovery_results AS source
WHERE source.provider_id = 'agy'
  AND EXISTS (
    SELECT 1
    FROM discovery_results AS destination
    WHERE destination.provider_id = 'antigravity'
      AND destination.method = source.method
      AND destination.endpoint IS source.endpoint
  );
UPDATE discovery_results SET provider_id = 'antigravity' WHERE provider_id = 'agy';

-- Combo targets are JSON values and may be pretty-printed. Rewrite only recognized model
-- step fields and string model targets, leaving labels, prompts, and user config untouched.
UPDATE combos AS combo
SET data = json_set(
  combo.data,
  '$.models',
  json((
    SELECT json_group_array(json(
      CASE
        WHEN step.type = 'text' THEN json_quote(
          CASE
            WHEN step.value LIKE 'agy/%' THEN 'antigravity' || substr(step.value, 4)
            ELSE step.value
          END
        )
        WHEN step.type = 'object' THEN json_replace(
          json_replace(
            json_replace(
              step.value,
              '$.provider',
              CASE
                WHEN json_extract(step.value, '$.provider') = 'agy' THEN 'antigravity'
                ELSE json_extract(step.value, '$.provider')
              END
            ),
            '$.providerId',
            CASE
              WHEN json_extract(step.value, '$.providerId') = 'agy' THEN 'antigravity'
              ELSE json_extract(step.value, '$.providerId')
            END
          ),
          '$.model',
          CASE
            WHEN json_extract(step.value, '$.model') LIKE 'agy/%'
              THEN 'antigravity' || substr(json_extract(step.value, '$.model'), 4)
            ELSE json_extract(step.value, '$.model')
          END
        )
        ELSE step.value
      END
    ))
    FROM json_each(combo.data, '$.models') AS step
  ))
)
WHERE json_valid(combo.data)
  AND json_type(combo.data, '$.models') = 'array';

-- The combo schema also accepts provider-id allowlists. Retain the agy entry while
-- adding the canonical provider so either spelling remains eligible if the field is enforced.
UPDATE combos AS combo
SET data = json_set(
  combo.data,
  '$.allowedProviders',
  json((
    SELECT json_group_array(json(merged.item_json))
    FROM (
      SELECT CASE provider.type
               WHEN 'text' THEN json_quote(provider.value)
               WHEN 'null' THEN 'null'
               WHEN 'true' THEN 'true'
               WHEN 'false' THEN 'false'
               ELSE json(provider.value)
             END AS item_json,
             0 AS source_order,
             CAST(provider.key AS INTEGER) AS item_order
      FROM json_each(combo.data, '$.allowedProviders') AS provider
      UNION ALL
      SELECT json_quote('antigravity') AS item_json,
             1 AS source_order,
             CAST(legacy.key AS INTEGER) AS item_order
      FROM json_each(combo.data, '$.allowedProviders') AS legacy
      WHERE legacy.type = 'text'
        AND legacy.value = 'agy'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(combo.data, '$.allowedProviders') AS existing
          WHERE existing.type = 'text' AND existing.value = 'antigravity'
        )
      ORDER BY source_order, item_order
    ) AS merged
  ))
)
WHERE json_valid(combo.data)
  AND json_type(combo.data, '$.allowedProviders') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(combo.data, '$.allowedProviders') AS legacy
    WHERE legacy.type = 'text' AND legacy.value = 'agy'
  );

-- Move provider-keyed catalog, compatibility, alias, and price rows. JSON objects are
-- shallow-patched source-first so existing canonical values win while agy-only entries
-- survive. Array catalogs/overrides merge by item id, with destination entries winning.
UPDATE key_value AS destination
SET value = json_patch(
  (SELECT source.value FROM key_value AS source
   WHERE source.namespace = destination.namespace AND source.key = 'agy'),
  destination.value
)
WHERE destination.namespace IN (
    'providerAliases',
    'pricing',
    'pricing_synced',
    'models_dev_pricing'
  )
  AND destination.key = 'antigravity'
  AND EXISTS (
    SELECT 1 FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  )
  AND json_valid(destination.value)
  AND json_type(destination.value) = 'object'
  AND json_valid((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  ))
  AND json_type((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  )) = 'object';

UPDATE key_value AS destination
SET value = (
  SELECT json_group_array(json(merged.item_json))
  FROM (
    SELECT destination_item.value AS item_json, 0 AS source_order,
           CAST(destination_item.key AS INTEGER) AS item_order
    FROM json_each(destination.value) AS destination_item
    UNION ALL
    SELECT source_item.value AS item_json, 1 AS source_order,
           CAST(source_item.key AS INTEGER) AS item_order
    FROM json_each((
      SELECT source.value FROM key_value AS source
      WHERE source.namespace = destination.namespace AND source.key = 'agy'
    )) AS source_item
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(destination.value) AS existing_item
      WHERE json_extract(existing_item.value, '$.id') = json_extract(source_item.value, '$.id')
    )
    ORDER BY source_order, item_order
  ) AS merged
)
WHERE destination.namespace IN ('customModels', 'modelCompatOverrides')
  AND destination.key = 'antigravity'
  AND EXISTS (
    SELECT 1 FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  )
  AND json_valid(destination.value)
  AND json_type(destination.value) = 'array'
  AND json_valid((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  ))
  AND json_type((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = destination.namespace AND source.key = 'agy'
  )) = 'array';

INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT namespace, 'antigravity', value
FROM key_value
WHERE key = 'agy'
  AND namespace IN (
    'customModels',
    'modelCompatOverrides',
    'providerAliases',
    'pricing',
    'pricing_synced',
    'models_dev_pricing'
  );
DELETE FROM key_value
WHERE key = 'agy'
  AND namespace IN (
    'customModels',
    'modelCompatOverrides',
    'providerAliases',
    'pricing',
    'pricing_synced',
    'models_dev_pricing'
  );

-- Synced catalogs are keyed per provider connection. Merge equal connection keys by model
-- id, retaining canonical catalog data on duplicate ids and all source-only model entries.
UPDATE key_value AS destination
SET value = (
  SELECT json_group_array(json(merged.item_json))
  FROM (
    SELECT destination_item.value AS item_json, 0 AS source_order,
           CAST(destination_item.key AS INTEGER) AS item_order
    FROM json_each(destination.value) AS destination_item
    UNION ALL
    SELECT source_item.value AS item_json, 1 AS source_order,
           CAST(source_item.key AS INTEGER) AS item_order
    FROM json_each((
      SELECT source.value FROM key_value AS source
      WHERE source.namespace = 'syncedAvailableModels'
        AND source.key = 'agy:' || substr(destination.key, length('antigravity:') + 1)
    )) AS source_item
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(destination.value) AS existing_item
      WHERE json_extract(existing_item.value, '$.id') = json_extract(source_item.value, '$.id')
    )
    ORDER BY source_order, item_order
  ) AS merged
)
WHERE destination.namespace = 'syncedAvailableModels'
  AND substr(destination.key, 1, length('antigravity:')) = 'antigravity:'
  AND EXISTS (
    SELECT 1 FROM key_value AS source
    WHERE source.namespace = 'syncedAvailableModels'
      AND source.key = 'agy:' || substr(destination.key, length('antigravity:') + 1)
  )
  AND json_valid(destination.value)
  AND json_type(destination.value) = 'array'
  AND json_valid((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = 'syncedAvailableModels'
      AND source.key = 'agy:' || substr(destination.key, length('antigravity:') + 1)
  ))
  AND json_type((
    SELECT source.value FROM key_value AS source
    WHERE source.namespace = 'syncedAvailableModels'
      AND source.key = 'agy:' || substr(destination.key, length('antigravity:') + 1)
  )) = 'array';

INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT namespace, 'antigravity:' || substr(key, length('agy:') + 1), value
FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('agy:')) = 'agy:';
DELETE FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('agy:')) = 'agy:';

-- Provider aliases are alias -> upstream model ID maps. Rewrite model values only; alias
-- keys are operator-owned names and remain byte-for-byte unchanged.
UPDATE key_value AS provider_aliases
SET value = (
  SELECT json_group_object(
    alias.key,
    CASE
      WHEN alias.type = 'text' AND alias.value LIKE 'agy/%'
        THEN 'antigravity' || substr(alias.value, 4)
      ELSE alias.value
    END
  )
  FROM json_each(provider_aliases.value) AS alias
)
WHERE provider_aliases.namespace = 'providerAliases'
  AND provider_aliases.key = 'antigravity'
  AND json_valid(provider_aliases.value)
  AND json_type(provider_aliases.value) = 'object';

UPDATE key_value
SET value = json_quote('antigravity/' || substr(json_extract(value, '$'), 5))
WHERE namespace = 'modelAliases'
  AND json_valid(value)
  AND json_type(value) = 'text'
  AND json_extract(value, '$') LIKE 'agy/%';

-- Per-key allow/block lists are literal JSON patterns. Retain each agy pattern and add its
-- canonical equivalent so migrated pins keep their existing authorization behavior.
UPDATE api_keys AS api_key
SET allowed_models = (
  SELECT json_group_array(json(merged.item_json))
  FROM (
    SELECT CASE item.type
             WHEN 'text' THEN json_quote(item.value)
             WHEN 'null' THEN 'null'
             WHEN 'true' THEN 'true'
             WHEN 'false' THEN 'false'
             ELSE json(item.value)
           END AS item_json,
           0 AS source_order,
           CAST(item.key AS INTEGER) AS item_order
    FROM json_each(api_key.allowed_models) AS item
    UNION ALL
    SELECT json_quote('antigravity' || substr(source.value, 4)) AS item_json,
           1 AS source_order,
           CAST(source.key AS INTEGER) AS item_order
    FROM json_each(api_key.allowed_models) AS source
    WHERE source.type = 'text'
      AND source.value LIKE 'agy/%'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(api_key.allowed_models) AS existing
        WHERE existing.type = 'text'
          AND existing.value = 'antigravity' || substr(source.value, 4)
      )
    ORDER BY source_order, item_order
  ) AS merged
)
WHERE json_valid(api_key.allowed_models)
  AND json_type(api_key.allowed_models) = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(api_key.allowed_models) AS legacy
    WHERE legacy.type = 'text' AND legacy.value LIKE 'agy/%'
  );

UPDATE api_keys AS api_key
SET blocked_models = (
  SELECT json_group_array(json(merged.item_json))
  FROM (
    SELECT CASE item.type
             WHEN 'text' THEN json_quote(item.value)
             WHEN 'null' THEN 'null'
             WHEN 'true' THEN 'true'
             WHEN 'false' THEN 'false'
             ELSE json(item.value)
           END AS item_json,
           0 AS source_order,
           CAST(item.key AS INTEGER) AS item_order
    FROM json_each(api_key.blocked_models) AS item
    UNION ALL
    SELECT json_quote('antigravity' || substr(source.value, 4)) AS item_json,
           1 AS source_order,
           CAST(source.key AS INTEGER) AS item_order
    FROM json_each(api_key.blocked_models) AS source
    WHERE source.type = 'text'
      AND source.value LIKE 'agy/%'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(api_key.blocked_models) AS existing
        WHERE existing.type = 'text'
          AND existing.value = 'antigravity' || substr(source.value, 4)
      )
    ORDER BY source_order, item_order
  ) AS merged
)
WHERE json_valid(api_key.blocked_models)
  AND json_type(api_key.blocked_models) = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(api_key.blocked_models) AS legacy
    WHERE legacy.type = 'text' AND legacy.value LIKE 'agy/%'
  );

-- Keep agy-scoped rules so legacy agy/model requests retain their grants and restrictions.
-- Add equivalent canonical rules unless one already exists; this also keeps old agy denies
-- effective for canonical requests, while runtime canonical-deny bridging covers alias calls.
INSERT OR IGNORE INTO group_model_permissions (
  id,
  group_id,
  model_pattern,
  provider,
  access_type,
  created_at
)
SELECT
  'agy-to-antigravity:' || source.id,
  source.group_id,
  CASE
    WHEN source.model_pattern LIKE 'agy/%'
      THEN 'antigravity' || substr(source.model_pattern, 4)
    ELSE source.model_pattern
  END,
  CASE WHEN source.provider = 'agy' THEN 'antigravity' ELSE source.provider END,
  source.access_type,
  source.created_at
FROM group_model_permissions AS source
WHERE source.access_type IN ('allow', 'deny')
  AND (source.provider = 'agy' OR source.model_pattern LIKE 'agy/%')
  AND NOT EXISTS (
    SELECT 1
    FROM group_model_permissions AS destination
    WHERE destination.group_id = source.group_id
      AND destination.model_pattern = CASE
        WHEN source.model_pattern LIKE 'agy/%'
          THEN 'antigravity' || substr(source.model_pattern, 4)
        ELSE source.model_pattern
      END
      AND destination.provider IS CASE
        WHEN source.provider = 'agy' THEN 'antigravity'
        ELSE source.provider
      END
      AND destination.access_type = source.access_type
  );

-- Keep historical model-ID rewriting for usage, calls, and aggregate history.
UPDATE usage_history SET model = 'antigravity' || substr(model, 4) WHERE model LIKE 'agy/%';
UPDATE call_logs SET model = 'antigravity' || substr(model, 4) WHERE model LIKE 'agy/%';
UPDATE hourly_usage_summary
SET model = 'antigravity' || substr(model, 4)
WHERE model LIKE 'agy/%';
UPDATE daily_usage_summary
SET model = 'antigravity' || substr(model, 4)
WHERE model LIKE 'agy/%';

-- Normalize the removed IDE profile to CLI. Rows with no clientProfile key keep
-- working through the runtime "cli" default.
UPDATE provider_connections
SET provider_specific_data = json_set(provider_specific_data, '$.clientProfile', 'cli')
WHERE provider = 'antigravity'
  AND json_valid(COALESCE(provider_specific_data, ''))
  AND json_extract(provider_specific_data, '$.clientProfile') IS NOT NULL
  AND json_extract(provider_specific_data, '$.clientProfile') != 'cli';
