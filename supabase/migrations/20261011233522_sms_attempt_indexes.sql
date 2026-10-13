-- Cover new attempt linkage and existing FKs used during claim/reconciliation.
begin;
create index sms_queue_current_attempt_idx on public.sms_queue(id, current_attempt_id);
create index sms_queue_device_idx on public.sms_queue(device_id);
create index sms_queue_claimed_by_idx on public.sms_queue(claimed_by);
create index sms_send_log_queue_idx on public.sms_send_log(queue_id);
create index sms_send_log_device_idx on public.sms_send_log(device_id);
commit;
