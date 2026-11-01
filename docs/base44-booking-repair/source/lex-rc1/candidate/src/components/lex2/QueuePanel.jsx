import {enqueuePersistedEvent, controlPersistedTask} from './lexQueueClient';
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play, RotateCcw, Ban, Trash2, Plus } from "lucide-react";

const STATUS_CLS = {
  queued: "bg-white/10 text-slate-300",
  prioritized: "bg-violet-500/15 text-violet-300",
  running: "bg-sky-500/15 text-sky-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  retrying: "bg-amber-500/15 text-amber-300",
  cancelled: "bg-white/5 text-slate-600",
};

export default function QueuePanel() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [form, setForm] = useState({
    task_type: "event_publish",
    payload: '{\n  "event_id": "persisted EventLog ID"\n}',
    priority: 5,
    scheduled_time: "",
  });
  const [error, setError] = useState("");
  const [enqueueing, setEnqueueing] = useState(false);

  async function load() {
    try {
      setTasks(await base44.entities.OrchestrationTask.list("-created_date", 30));
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function enqueue() {
    let payload;
    try {
      payload = JSON.parse(form.payload || "{}");
    } catch {
      setError("Payload must be valid JSON");
      return;
    }
    if (!payload.event_id || (form.task_type === "webhook_redeliver" && !payload.connection_id)) {
      setError("Use a persisted event_id; webhook_redeliver also requires connection_id");
      return;
    }
    setEnqueueing(true);
    setError("");
    try {
      await enqueuePersistedEvent(base44, form.task_type, payload, {priority:Number(form.priority), scheduled_time:form.scheduled_time ? new Date(form.scheduled_time).toISOString() : null});
      setForm((f) => ({ ...f, payload: '{\n  "event_id": "persisted EventLog ID"\n}' }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setEnqueueing(false);
    }
  }

  async function runQueue() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await base44.functions.invoke("lexQueue", { op: "run" });
      setRunResult(res.data);
      await load();
    } catch (e) {
      setRunResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  }

  async function retry(t) {
    await controlPersistedTask(base44, 'retry', t.id);
    load();
  }

  async function cancel(t) {
    await controlPersistedTask(base44, 'cancel', t.id);
    load();
  }

  async function remove(t) {
    await controlPersistedTask(base44, 'archive', t.id);
    load();
  }

  return (
    <div className="space-y-4">
      {/* Enqueue form */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
            Orchestration Queue · Enqueue
          </h3>
          <Button
            size="sm"
            onClick={runQueue}
            disabled={running}
            className="border border-emerald-400/30 bg-emerald-500/10 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20"
          >
            {running ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3 w-3" />
            )}
            Run Queue
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] text-slate-400">Task Type</Label>
            <Select
              value={form.task_type}
              onValueChange={(v) => setForm((f) => ({ ...f, task_type: v }))}
            >
              <SelectTrigger className="border-white/10 bg-white/[0.02] font-mono text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#0b1120]">
                <SelectItem value="event_publish" className="font-mono text-[11px]">
                  republish stored event
                </SelectItem>
                <SelectItem value="webhook_redeliver" className="font-mono text-[11px]">
                  webhook redeliver
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] text-slate-400">Priority (1 = highest)</Label>
            <Input
              type="number"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              className="border-white/10 bg-white/[0.02] font-mono text-[12px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] text-slate-400">Scheduled (optional)</Label>
            <Input
              type="datetime-local"
              value={form.scheduled_time}
              onChange={(e) => setForm((f) => ({ ...f, scheduled_time: e.target.value }))}
              className="border-white/10 bg-white/[0.02] font-mono text-[12px]"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label className="font-mono text-[11px] text-slate-400">Persisted event selection (JSON)</Label>
            <Textarea
              value={form.payload}
              onChange={(e) => setForm((f) => ({ ...f, payload: e.target.value }))}
              className="border-white/10 bg-white/[0.02] font-mono text-[11px]"
              rows={4}
            />
          </div>
        </div>
        {error && <p className="mt-2 font-mono text-[11px] text-rose-400">{error}</p>}
        <div className="mt-3 flex items-center justify-between">
          <Button
            size="sm"
            variant="outline"
            onClick={enqueue}
            disabled={enqueueing}
            className="border-white/10 bg-white/[0.02] font-mono text-[11px] text-slate-200 hover:bg-white/[0.06]"
          >
            {enqueueing ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-3 w-3" />
            )}
            Enqueue Task
          </Button>
          {runResult && (
            <p className="font-mono text-[11px] text-slate-400">
              {runResult.error ? (
                <span className="text-rose-400">{runResult.error}</span>
              ) : (
                <span>
                  run: {runResult.processed} processed · {runResult.completed} completed ·{" "}
                  {runResult.retrying} retrying · {runResult.failed} failed
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Task list */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
            Queue · Recent Tasks
          </h3>
          <span className="font-mono text-[11px] text-slate-500">{tasks.length} records</span>
        </div>
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex h-32 items-center justify-center font-mono text-[11px] text-slate-600">
            queue empty — enqueue an operation above
          </div>
        ) : (
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-slate-200">
                      {t.task_type.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${STATUS_CLS[t.status] || STATUS_CLS.queued}`}
                    >
                      {t.status}
                    </span>
                    <span className="font-mono text-[10px] text-slate-600">p{t.priority ?? 5}</span>
                    {t.retry_count > 0 && (
                      <span className="font-mono text-[10px] text-amber-400/80">
                        retries {t.retry_count}/{t.max_retries ?? 3}
                      </span>
                    )}
                  </div>
                  <p className="truncate font-mono text-[10px] text-slate-500">
                    {t.failure_reason ||
                      (t.completed_time
                        ? `completed ${new Date(t.completed_time).toLocaleTimeString()}`
                        : t.scheduled_time
                          ? `scheduled ${new Date(t.scheduled_time).toLocaleString()}`
                          : "ready")}
                  </p>
                </div>
                {["queued", "retrying", "prioritized"].includes(t.status) && (
                  <button
                    onClick={() => retry(t)}
                    title="Requeue"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-400 hover:text-emerald-400"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
                {["queued", "retrying", "prioritized", "running"].includes(t.status) && (
                  <button
                    onClick={() => cancel(t)}
                    title="Cancel"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-400 hover:text-amber-400"
                  >
                    <Ban className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => remove(t)}
                  title="Archive"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}