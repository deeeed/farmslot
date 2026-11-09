export function fixture(confirm: boolean): Promise<{
  root: string;
  executable: string;
  requests: string;
  argv: string;
}>;
