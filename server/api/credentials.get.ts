import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { getCredentialSummary } from '../credentials.ts'
export default defineGcsExtensionRouteHandler(getCredentialSummary)
