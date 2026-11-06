-- 009: the Assumptions category-% boxes were saved FILLED with the template defaults
-- (admin / R&M / rehab 5%, everything else 0%) even when nobody touched them, and the
-- engine now lets a typed category % outrank every GL's foundation factor. Strip the
-- untouched defaults from existing annual budgets so they keep their per-GL factors;
-- only a value a user actually changed survives (blank box = foundation factor).
update budgets
set inputs = jsonb_set(
  inputs, '{baseline,growthPct}',
  coalesce(
    (select jsonb_object_agg(e.k, e.v)
       from jsonb_each(inputs->'baseline'->'growthPct') as e(k, v)
      where not (
        (e.k in ('9', '13', '14') and e.v::text = '0.05')
        or (e.k not in ('9', '13', '14') and e.v::text = '0')
      )),
    '{}'::jsonb
  )
)
where inputs->'baseline' ? 'growthPct'
  and jsonb_typeof(inputs->'baseline'->'growthPct') = 'object';
