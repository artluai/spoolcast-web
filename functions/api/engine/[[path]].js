import { authenticatedEngineRequest } from '../_engine.js'

export async function onRequest(context) {
  return authenticatedEngineRequest({
    ...context,
    path: context.params.path,
  })
}
