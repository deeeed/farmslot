import path from 'node:path';

/** The worker allocation keeps the gateway task's flow and folder identity. */
export function workerTaskDirectory(
  taskFile: string,
  remoteRepo: string,
  taskDirName: string,
): string {
  const taskDir = path.dirname(taskFile);
  return path.posix.join(
    remoteRepo,
    taskDirName,
    path.basename(path.dirname(taskDir)),
    path.basename(taskDir),
  );
}
