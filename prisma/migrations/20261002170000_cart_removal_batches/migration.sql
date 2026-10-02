-- Keep saved removal outcomes readable under the canonical batch argument shape.
-- This changes only argument representation, never invocation status or results.
UPDATE "ToolInvocation"
SET "argumentsJson" = json_remove(
  json_set("argumentsJson", '$.lineKeys', json_array(json_extract("argumentsJson", '$.lineKey'))),
  '$.lineKey'
)
WHERE "name" = 'remove_from_cart'
  AND json_valid("argumentsJson")
  AND json_type("argumentsJson", '$.lineKey') = 'text'
  AND json_type("argumentsJson", '$.lineKeys') IS NULL;
