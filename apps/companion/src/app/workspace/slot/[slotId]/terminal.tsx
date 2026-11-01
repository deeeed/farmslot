import { OfflineShown } from '../../../../components/offline-shown';
import SlotTerminalScreen from '../../../../features/terminal/SlotTerminalScreen';

/** The slot terminal shows the connection banner, so its read-status slot need not. */
export default function SlotTerminalRoute() {
  return (
    <OfflineShown.Provider value={true}>
      <SlotTerminalScreen />
    </OfflineShown.Provider>
  );
}
