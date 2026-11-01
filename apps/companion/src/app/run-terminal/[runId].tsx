import { Redirect, useLocalSearchParams } from 'expo-router';

/** Old review-worktree terminal links open the one terminal on that run's pane. */
export default function LegacyRunTerminalRoute() {
  const params = useLocalSearchParams();
  return <Redirect href={{ pathname: '/terminal/worker', params }} />;
}
