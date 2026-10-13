import path from 'node:path';

import type { SourceLock, SourceMaterialization, SourceNodeStatus } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { SourceMaterializer } from '@farmslot/slot-config/sources';

/** No ref resolver here: nodes receive exact authoritative locks only. */
export class NodeSources {
  private materializer: SourceMaterializer;

  constructor(nodeId: string, root = path.join(farmslotHome(), 'sources', 'node')) {
    this.materializer = new SourceMaterializer(nodeId, root);
  }

  materialize(lock: SourceLock): Promise<SourceMaterialization> {
    return this.materializer.materialize(lock);
  }
  verify(lock: SourceLock): Promise<SourceMaterialization> {
    return this.materializer.verify(lock);
  }
  status(): Promise<SourceNodeStatus> {
    return this.materializer.status();
  }
}
