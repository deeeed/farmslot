import { type AcpObject, acpObject, acpString } from './acp-rpc.js';

type Request = (method: string, params: AcpObject) => Promise<unknown>;

/** Cursor ACP's parameterized model API; CLI --model is ignored by its ACP command. */
export async function configureCursorModel(
  sessionId: string,
  session: AcpObject,
  requested: string,
  request: Request,
): Promise<void> {
  const initial = (session.configOptions as AcpObject[] | undefined) ?? [];
  const models = initial.find((option) => option.id === 'model')?.options;
  if (!Array.isArray(models)) throw new Error('Cursor did not advertise model choices');
  const ids = models.map((option) => acpString(acpObject(option).value));
  let model = requested;
  const parameters = new Map<string, string>();
  const explicit = /^([^\[\]]+)\[([^\[\]]*)\]$/.exec(requested);
  if (explicit) {
    model = explicit[1];
    for (const field of explicit[2].split(',').filter(Boolean)) {
      const match = /^([^=\s]+)=([^=\s]+)$/.exec(field);
      if (!match || parameters.has(match[1])) throw new Error('Invalid Cursor model parameters');
      parameters.set(match[1], match[2]);
    }
  } else if (!ids.includes(model)) {
    // These are Cursor's CLI aliases, also used by the shared manual-dispatch picker.
    model = model
      .replace(/^cursor-(?=grok-)/, '')
      .replace(/^claude-(\d+)\.(\d+)-(opus|sonnet|haiku)/, 'claude-$3-$1-$2');
    if (model === 'auto' && ids.includes('auto-smart')) model = 'auto-smart';
    parameters.set('fast', 'false');
    while (!ids.includes(model)) {
      const suffix = /-(extra-high|thinking|fast|minimal|none|low|medium|high|xhigh|max)$/.exec(
        model,
      );
      if (!suffix) break;
      model = model.slice(0, -suffix[0].length);
      const value = suffix[1];
      if (value === 'thinking' || value === 'fast') parameters.set(value, 'true');
      else {
        if (parameters.has('$effort')) throw new Error('Ambiguous Cursor model effort');
        parameters.set('$effort', value === 'extra-high' ? 'xhigh' : value);
      }
    }
  }
  if (!ids.includes(model)) throw new Error(`Cursor model is unavailable: ${requested}`);
  const update = async (id: string, value: string) => {
    const result = acpObject(
      await request('session/set_config_option', { sessionId, configId: id, value }),
    );
    if (!Array.isArray(result.configOptions))
      throw new Error('Cursor did not confirm model settings');
    return result.configOptions.map(acpObject);
  };
  let choices = await update('model', model);
  for (const [key, value] of parameters) {
    const option =
      key === '$effort'
        ? choices.find(
            (entry) =>
              entry.category === 'thought_level' &&
              Array.isArray(entry.options) &&
              entry.options.some((choice) => acpObject(choice).value === value),
          )
        : choices.find((entry) => entry.id === key);
    if (!option) {
      if (key === 'fast' && value === 'false') continue;
      throw new Error(`Cursor model does not support ${key}: ${requested}`);
    }
    const options = Array.isArray(option.options) ? option.options.map(acpObject) : [];
    if (!options.some((entry) => entry.value === value))
      throw new Error(`Cursor model does not support ${key}=${value}: ${requested}`);
    choices = await update(acpString(option.id), value);
    if (choices.find((entry) => entry.id === option.id)?.currentValue !== value)
      throw new Error(`Cursor did not select ${key}=${value}`);
  }
  if (choices.find((entry) => entry.id === 'model')?.currentValue !== model)
    throw new Error('Cursor did not select the requested model');
}
