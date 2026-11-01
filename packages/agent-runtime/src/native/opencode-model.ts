import { type AcpObject, acpObject, acpString } from './acp-rpc.js';

type Request = (method: string, params: AcpObject) => Promise<unknown>;

/** OpenCode ACP selects the model through its `model` session config option. */
export async function configureOpenCodeModel(
  sessionId: string,
  session: AcpObject,
  requested: string,
  request: Request,
): Promise<void> {
  const options = ((session.configOptions as AcpObject[] | undefined) ?? []).map(acpObject);
  const choices = options.find((option) => option.id === 'model')?.options;
  if (!Array.isArray(choices)) throw new Error('OpenCode did not advertise model choices');
  if (!choices.some((choice) => acpString(acpObject(choice).value) === requested))
    throw new Error(`OpenCode model is unavailable: ${requested}`);
  const result = acpObject(
    await request('session/set_config_option', { sessionId, configId: 'model', value: requested }),
  );
  const current = (Array.isArray(result.configOptions) ? result.configOptions : [])
    .map(acpObject)
    .find((option) => option.id === 'model')?.currentValue;
  if (current !== requested) throw new Error('OpenCode did not confirm the requested model');
}
