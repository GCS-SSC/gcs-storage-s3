import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { saveCredential } from '../credentials'
export default defineGcsExtensionRouteHandler(saveCredential)

