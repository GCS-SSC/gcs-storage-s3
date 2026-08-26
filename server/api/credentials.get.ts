import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { getCredentialSummary } from '../credentials'
export default defineGcsExtensionRouteHandler(getCredentialSummary)

