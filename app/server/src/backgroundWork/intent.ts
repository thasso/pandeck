/**
 * What a launch tells the agent about the job it just started: its PA id and
 * how to say nobody waits on it. Every new job counts as awaited work until
 * its owner declares otherwise, so a dev server left undeclared keeps its tree
 * reading as busy.
 */
export function backgroundWorkIntentHint(taskId: string): string {
  return `PA background task ${taskId} counts as work you are waiting on. If nobody waits on it (a dev server, a watcher), call background_tasks with operation set_intent, taskId ${taskId} and intent service.`;
}
