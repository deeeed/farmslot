import { useLocalSearchParams } from 'expo-router';

import { ResolvedTerminal } from '../../../../features/terminal/ResolvedTerminal';
import { terminalLinkFromParams } from '../../../../features/terminal/TerminalScreen';

/** The slot's Terminal tab is the same terminal as Terminals, on the pane the link names. */
export default function SlotTerminalRoute() {
  const { selector, draft } = terminalLinkFromParams(useLocalSearchParams());
  return <ResolvedTerminal selector={selector} embedded initialDraft={draft} />;
}
