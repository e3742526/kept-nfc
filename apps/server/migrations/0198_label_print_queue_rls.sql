ALTER TABLE public.label_print_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_print_queue FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.label_print_queue FROM kept_app, kept_system;
GRANT SELECT, INSERT, DELETE ON public.label_print_queue TO kept_app;
GRANT UPDATE (location_id, batch_id) ON public.label_print_queue TO kept_app;
CREATE POLICY owner_all ON public.label_print_queue FOR ALL TO kept_owner
  USING (true) WITH CHECK (true);
CREATE POLICY app_own_queue ON public.label_print_queue FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
    AND location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (user_id = (SELECT kept.current_user_id())
    AND location_id IN (SELECT kept.writable_location_ids()));
