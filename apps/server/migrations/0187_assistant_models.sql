-- Model choices come from the provider already entitled to pay for this context.
-- Provider managers can also pick from that provider's stored text model list.
CREATE FUNCTION kept.assistant_models(p_location uuid)
RETURNS TABLE (provider_id uuid, model text, vision boolean, is_default boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id, candidate.model,
         coalesce((listed.entry->>'vision')::boolean,
                  CASE WHEN p.capabilities->>'model' = candidate.model
                       THEN (p.capabilities->>'vision')::boolean END,
                  candidate.model = p.models->>'vision', false),
         candidate.model = chosen.model
    FROM kept.ai_provider_for(p_location, 'assistant') chosen
    JOIN public.ai_providers p ON p.id = chosen.provider_id
    CROSS JOIN LATERAL (
      SELECT chosen.model
      UNION SELECT p.models->>'vision'
      UNION SELECT entry->>'id'
        FROM jsonb_array_elements(coalesce(p.model_list, '[]'::jsonb)) entry
       WHERE kept.ai_provider_managed(p.id)
         AND coalesce((entry->>'text')::boolean, true)
         AND NOT coalesce((entry->>'embeddings')::boolean, false)
    ) candidate
    LEFT JOIN LATERAL (
      SELECT entry FROM jsonb_array_elements(coalesce(p.model_list, '[]'::jsonb)) entry
       WHERE entry->>'id' = candidate.model LIMIT 1
    ) listed ON true
   WHERE length(candidate.model) BETWEEN 1 AND 120
   ORDER BY 4 DESC, 3 DESC, 2
   LIMIT 100
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.assistant_models(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.assistant_models(uuid) TO kept_app;
