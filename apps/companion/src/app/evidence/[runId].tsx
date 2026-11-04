import { withViewState } from '../../components/view-state';
// The run files viewer as its own stack screen, opened on one acceptance
// criterion's evidence; closing it returns to whichever screen opened it.
import Screen from '../../features/artifacts/ArtifactViewerScreen';
export default withViewState(Screen);
