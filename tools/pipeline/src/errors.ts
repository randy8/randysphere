/**
 * A failure the person running the command can act on: a bad config value, a
 * missing file, a rejected upload. The CLI prints the message alone, with no
 * stack trace, because the stack is noise when the message is the whole point.
 *
 * Anything else that escapes is a bug in the pipeline and gets a full stack.
 */
export class PipelineError extends Error {
  override readonly name = 'PipelineError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
