export interface TaskPathReference {
  line: number;
  relativePath: string;
}

export function taskPaths(document: string): TaskPathReference[];
export function taskLayoutDocIssues(document: string): TaskPathReference[];
