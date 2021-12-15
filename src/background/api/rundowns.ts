import { ipcMain } from 'electron'
import {
	DBRundown,
	IpcOperation,
	IpcOperationType,
	MutationRundownCreate,
	MutationRundownDelete,
	MutationRundownRead,
	MutationRundownUpdate,
	Rundown
} from '../interfaces'
import { db } from '../db'
import { v4 as uuid } from 'uuid'
import { coreHandler } from '../coreHandler'
import { PeripheralDeviceAPI } from '@sofie-automation/server-core-integration'
import { createAllSegmentsInCore } from './segments'

export function mutateRundown(rundown: Rundown) {
	return {
		externalId: rundown.id,
		name: rundown.name,
		type: 'sofie-rundown-editor', // ?
		payload: {
			name: rundown.name,
			expectedStart: rundown.expectedStartTime,
			expectedEnd: rundown.expectedEndTime,
			...(rundown.metaData || {})
		}
	}
}

async function sendRundownDiffToCore(oldDocument: Rundown, newDocument: Rundown) {
	if (oldDocument.sync && !newDocument.sync) {
		return coreHandler.core.callMethod(PeripheralDeviceAPI.methods.dataRundownDelete, [
			oldDocument.id
		])
	} else if (!oldDocument.sync && newDocument.sync) {
		await coreHandler.core.callMethod(PeripheralDeviceAPI.methods.dataRundownCreate, [
			mutateRundown(newDocument)
		])
		await createAllSegmentsInCore(newDocument.id)
	} else if (oldDocument.sync && newDocument.sync) {
		return coreHandler.core.callMethod(PeripheralDeviceAPI.methods.dataRundownUpdate, [
			mutateRundown(newDocument)
		])
	}
}

export const mutations = {
	async create(payload: MutationRundownCreate): Promise<{ result?: Rundown; error?: Error }> {
		const id = uuid()
		const document: Partial<MutationRundownCreate> = {
			...payload
		}
		delete document.id
		delete document.playlistId

		const { result, error } = await new Promise((resolve) =>
			db.run(
				`
			INSERT INTO rundowns (id,playlistId,document)
			VALUES (?,?,json(?));
		`,
				[id, payload.playlistId || null, JSON.stringify(document)],
				function(e: Error | null) {
					if (e) {
						resolve({ result: undefined, error: e })
					} else if (this) {
						resolve({ result: this.lastID, error: undefined })
					}
				}
			)
		)

		if (result) {
			const document = await new Promise<DBRundown>((resolve) =>
				db.get(
					`
				SELECT *
				FROM rundowns
				WHERE id = ?
				LIMIT 1;
			`,
					[id],
					(e, r) => {
						console.log(e, r)
						resolve(r)
					}
				)
			)

			return {
				result: {
					...JSON.parse(document.document),
					id: document.id,
					playlistId: document.playlistId
				} as Rundown
			}
		}

		return { error: error as Error }
	},
	async read(
		payload: Partial<MutationRundownRead>
	): Promise<{ result?: Rundown | Rundown[]; error?: Error }> {
		if (payload && payload.id) {
			const document = await new Promise<DBRundown>((resolve, reject) =>
				db.get(
					`
				SELECT *
				FROM rundowns
				WHERE id = ?
				LIMIT 1;
			`,
					[payload.id],
					(e, r) => (e ? reject(e) : resolve(r))
				)
			)

			return {
				result: {
					...JSON.parse(document.document),
					id: document.id,
					playlistId: document.playlistId
				}
			}
		} else {
			const documents = await new Promise<DBRundown[]>((resolve, reject) =>
				db.all(
					`
				SELECT *
				FROM rundowns
			`,
					(e, r) => (e ? reject(e) : resolve(r))
				)
			)

			return {
				result: documents.map((d) => ({
					...JSON.parse(d.document),
					id: d.id,
					playlistId: d.playlistId
				}))
			}
		}
	},
	async update(payload: MutationRundownUpdate): Promise<{ result?: Rundown; error?: Error }> {
		const update = {
			...payload,
			id: null,
			playlistId: null
		}
		const { result, error } = await new Promise((resolve) =>
			db.run(
				`
			UPDATE rundowns
			SET playlistId = ?, document = (SELECT json_patch(rundowns.document, json(?)) FROM rundowns WHERE id = ?)
			WHERE id = "${payload.id}";
		`,
				[payload.playlistId || null, JSON.stringify(update), payload.id],
				(e) =>
					e ? resolve({ result: undefined, error: e }) : resolve({ result: true, error: undefined })
			)
		)

		if (result) {
			const document = await new Promise<DBRundown>((resolve) =>
				db.get(
					`
				SELECT *
				FROM rundowns
				WHERE id = ?
				LIMIT 1;
			`,
					[payload.id],
					(e, r) => {
						console.log(e, r)
						resolve(r)
					}
				)
			)

			return {
				result: {
					...JSON.parse(document.document),
					id: document.id,
					playlistId: document.playlistId
				}
			}
		}

		return error
	},
	async delete(payload: MutationRundownDelete): Promise<{ error?: Error }> {
		return new Promise((resolve) =>
			db.exec(
				`
			BEGIN TRANSACTION;
			DELETE FROM rundowns
			WHERE id = "${payload.id}";
			DELETE FROM segments
			WHERE rundownId = "${payload.id}";
			DELETE FROM parts
			WHERE rundownId = "${payload.id}";
			DELETE FROM pieces
			WHERE rundownId = "${payload.id}";
			COMMIT;
		`,
				(error: Error | null) => resolve({ error: error || undefined })
			)
		)
	}
}

ipcMain.handle('rundowns', async (_, operation: IpcOperation) => {
	if (operation.type === IpcOperationType.Create) {
		const { result, error } = await mutations.create(operation.payload)

		if (result && result.sync) {
			coreHandler.core.callMethod(PeripheralDeviceAPI.methods.dataRundownCreate, [
				mutateRundown(result)
			])
		}

		return result || error
	} else if (operation.type === IpcOperationType.Read) {
		const { result, error } = await mutations.read(operation.payload)

		return result || error
	} else if (operation.type === IpcOperationType.Update) {
		const { result: document } = await mutations.read({ id: operation.payload.id })
		const { result, error } = await mutations.update(operation.payload)

		if (document && 'id' in document && result) {
			sendRundownDiffToCore(document, result)
		}

		return result || error
	} else if (operation.type === IpcOperationType.Delete) {
		const { result: document } = await mutations.read({ id: operation.payload.id })
		const { error } = await mutations.delete(operation.payload)

		if (document && 'id' in document && !error) {
			coreHandler.core.callMethod(PeripheralDeviceAPI.methods.dataRundownDelete, [document.id])
		}

		return error || true
	}
})
