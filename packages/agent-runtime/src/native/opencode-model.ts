import {
  acpConfigChoices,
  type AcpObject,
  type AcpRequest,
  setAcpConfigOption,
} from './acp-rpc.js';

/** OpenCode ACP selects the model through its `model` session config option. */
export async function configureOpenCodeModel(
  sessionId: string,
  session: AcpObject,
  requested: string,
  request: AcpRequest,
): Promise<void> {
  const ids = acpConfigChoices(session, 'model');
  if (!ids) throw new Error('OpenCode did not advertise model choices');
  if (!ids.includes(requested)) throw new Error(`OpenCode model is unavailable: ${requested}`);
  const options = await setAcpConfigOption(request, sessionId, 'model', requested, 'OpenCode');
  if (options.find((option) => option.id === 'model')?.currentValue !== requested)
    throw new Error('OpenCode did not confirm the requested model');
}
