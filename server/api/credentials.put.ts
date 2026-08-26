import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { saveCredential } from '../credentials.ts'
export default defineGcsExtensionRouteHandler(saveCredential)
