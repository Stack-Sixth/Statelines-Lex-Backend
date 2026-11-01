// Call only from the authenticated admin QueuePanel. No generic task proxy.
export async function enqueuePersistedEvent(base44, taskType, input, options = {}) {
  if (!['webhook_redeliver', 'event_publish'].includes(taskType)) throw new Error('Use an authorized producer for this task type');
  if (!input?.event_id || (taskType === 'webhook_redeliver' && !input.connection_id)) throw new Error('Persisted event_id and destination required');
  if (Object.keys(input).some(key => !['event_id', 'connection_id'].includes(key))) throw new Error('Only persisted event/destination IDs are accepted');
  const storageKey = 'lex-queue:' + JSON.stringify([taskType, input.event_id, input.connection_id || '', options.priority ?? 5, options.scheduled_time || null]);
  const requestId = sessionStorage.getItem(storageKey) || crypto.randomUUID();
  sessionStorage.setItem(storageKey, requestId);
  const response = await base44.functions.invoke('lexQueueControl', {op:'enqueue', request_id:requestId, task_type:taskType, event_id:input.event_id, priority:options.priority ?? 5, scheduled_time:options.scheduled_time || null, ...(taskType === 'webhook_redeliver' ? {connection_id:input.connection_id} : {})});
  if (!response.data?.queued) throw new Error(response.data?.error || 'Pending: retry the same request');
  // Keep the request id until the operator explicitly starts a new logical job.
  // A lost response or repeated click must reconcile the same persisted task.
  return response.data;
}
export async function controlPersistedTask(base44, op, taskId) {
  const response = await base44.functions.invoke('lexQueueControl', {op:op === 'delete' ? 'archive' : op, task_id:taskId});
  if (response.data?.updated !== 1) throw new Error(response.data?.error || 'Task changed; reload before retry');
  return response.data;
}
