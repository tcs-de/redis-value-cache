/* eslint-disable unicorn/prefer-event-target */
import EventEmitter from "node:events";
import { setTimeout } from "node:timers/promises";


const db: Record<string, (string | Record<string, string>)> = {
	key1: "value1",
	key2: "value2",
	key3: "value3",
	key4: "value4",
	key5: "value5",
	key6: {
		object: JSON.stringify({ value: 6, info: "Info 1" }),
		type: "object"
	},
	key7: {
		object: JSON.stringify({ value: 7, info: "Info 2" }),
		type: "object"
	},
	key8: {
		object: JSON.stringify({ value: 8, info: "Info 3" }),
		type: "object"
	},
	key9: {
		object: JSON.stringify({ value: 9, info: "Info 4" }),
		type: "object"
	},
	key10: {
		object: JSON.stringify({ value: 10, info: "Info 5" }),
		type: "object"
	},

};

const connectedClients = new Set<Client>();

export class Client extends EventEmitter {
	private connected = false;
	private open = false;
	private listener: ((msg: string) => Promise<void>) | undefined;

	public isOpen() {
		return this.open;
	}

	public async connect() {
		await setTimeout(1);
		connectedClients.add(this);
		this.open = true;
		this.emit("ready");
	}

	public async disconnect() {
		await setTimeout(1);
		connectedClients.delete(this);
		this.open = false;
		this.emit("end");
	}

	public async quit() {
		await this.disconnect();
	}

	public duplicate() {
		return new Client();
	}

	// to fake disconnect
	public loseConnection() {
		this.emit("error", new Error("Connection Issues"));
	}

	// to fake reconnect
	public regainConnection() {
		this.emit("ready");
	}

	public async subscribe(name: string, listener: (msg: string) => Promise<void>) {
		await setTimeout(1);
		this.listener = listener;
	}

	public async pSubscribe(name: string, listener: (msg: string) => Promise<void>) {
		await this.subscribe(name, listener);
	}

	public async sendMessage(msg: string) {
		if (this.listener) {
			await this.listener(msg);
		}
	}

	public static async publish(msg: string) {
		const promises: Promise<void>[] = [];

		for (const client of connectedClients) {
			promises.push(client.sendMessage(msg));
		}

		await Promise.all(promises);
	}

	public async GET(key: string) {
		await setTimeout(1);
		console.log("Get is called");
		const value = db[key];
		console.log(value);
		if (value && typeof value === "string") {
			return value;
		}
		return null;
	}

	public async HGET(key: string, argument: string) {
		await setTimeout(1);
		const object = db[key];
		if (object && typeof object !== "string") {
			const value = object[argument];
			if (value) {
				return value;
			}
		}
		return null;
	}

	public async HGETALL(key: string) {
		await setTimeout(1);
		const object = db[key];
		if (object && typeof object !== "string") {
			return object;
		}
		return null;
	}

	public static serverDisconnect() {
		for (const client of connectedClients) {
			client.loseConnection();
		}
	}

	public static serverConnect() {
		for (const client of connectedClients) {
			client.regainConnection();
		}
	}

	public static async serverSendMessage(msg: string) {
		const promises: Promise<void>[] = [];
		for (const client of connectedClients) {
			promises.push(client.sendMessage(msg));
		}
		await Promise.all(promises);
	}


}


export default { createClient: () => new Client() };
