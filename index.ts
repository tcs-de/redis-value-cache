/* eslint-disable unicorn/prefer-event-target */
import { LRUCache } from "lru-cache";
import type { RedisClientOptions } from "redis";
import { createClient } from "redis";
import cloneDeep from "lodash.clonedeep";
import EventEmitter from "node:events";

export type RedisGetOpts = {
	type: "HGET";
	argument: string;
} | {
	type: "GET";
} | {
	type: "HGETALL";
};

export type RedisChannelOpts = {
	type: "subscribe" | "pSubscribe";
	name: string;
};

export type GenKeyFromMsg = (msg: string) => string | null | undefined;
// any because it depends on the GetOpts
export type ValueTransformer<T> = (rVal: any) => T | null | undefined;
export type AdditionalValueFetchMethode<T> = (key: string) => Promise<T | null | undefined>;

export interface GetOpts {
	clone?: boolean;
}

/**
 * options for the constructor of the redis object cache.
 *
 * @property redisClientOpts: Options for the redis connection. Will be used for client and subscriber(client.duplicate()).
 * @property redisChannelOpts: Make the subscriber subscribe to 1 channel or pSubscribe to multiple channels.
 * @property cacheMaxSize: Max Number of Object to store in the lru-cache.
 * @property fetchOpts: Options for wich method the client should use when fetching data from redis
 * @property genKeyFromMsg:
 * 	Function that takes a message that was send over the redis channel and returns a key that needs to be updated.
 * 	Return null to ignore message.
 *	This function must not be async.
 * @property redisValueTransformer:
 * 	Function that takes a value returned from redis (please remember to check for misses) and transforms it into a value that should be stored in lru cache.
 * 	Return null to ignore value.
 *	This function must not be async.
 * @property handleErrors: Opts how to handle Error. Undefined behaves the same as "warn"
 * 	"warn": console.warn(error);
 * 	"ignore": // do nothing
 * 	"throw": throw error;
 * 	"emit": this.emit("unexpectedError", error);
 * @property additionalValueFetchMethode: Optional function to be called in case a key can not be found in redis.
 * This means the function is called if a the redisValueTransformer function returns null;
 * @property fetchOnMessage: Whether a key should be also fetched or just deleted when a message is received (Default = false).
 *
 * @interface Opts
 * @template storedValueType
 */
export interface Opts<storedValueType extends NonNullable<unknown> = NonNullable<unknown>>{
	redisClientOpts: RedisClientOptions;
	redisChannelOpts: RedisChannelOpts;
	redisGetOpts: RedisGetOpts;
	genKeyFromMsg: GenKeyFromMsg;
	valueTransformer: ValueTransformer<storedValueType>;
	cacheMaxSize?: number;
	handleErrors?: "emit"|"warn"|"throw"|"ignore";
	additionalValueFetchMethod?: AdditionalValueFetchMethode<storedValueType>;
	fetchOnMessage?: boolean;
}

/**
 * An object that caches an automatically updates your values from redis
 *
 * @class RedisObjectCache
 * @extends {EventEmitter} Even though certain errors are emitted "normal" errors like trying to get a value before connecting or invalid opts are still thrown.
 * @emits error to pass along error emits of client and subscriber. 1st parameter is the error second parameter is "subscriber" or "client".
 * @emits ready when both client and subscriber (and by extension the class) are ready.
 * @emits unexpectedError when the handleErrors option is set to "emit" and an unexpected error shows up (usually in fetch function).
 * @template storedValueType
 */
export class RedisValueCache<storedValueType extends NonNullable<unknown> = NonNullable<unknown>> extends EventEmitter {
	private opts: Opts<storedValueType>;
	private objectCache: LRUCache<string, storedValueType>;
	private client: ReturnType<(typeof createClient)>;
	private subscriber: ReturnType<(typeof createClient)>;
	private genKeyFromMsg: GenKeyFromMsg;
	private valueTransformer: ValueTransformer<storedValueType>;
	private additionalValueFetchMethod: AdditionalValueFetchMethode<storedValueType> | undefined;
	private redisGetOpts: RedisGetOpts;
	private fetchOnMessage = false;
	private clientConnected = false;
	private subscriberConnected = false;

	constructor(opts: Opts<storedValueType>) {
		super();
		this.checkOpts(opts);
		// to be sure there are no changes later on
		this.opts = cloneDeep(opts);
		// create client and subscriber + add listeners
		this.client = createClient(this.opts.redisClientOpts);
		this.client.on("ready", () => {
			this.clientConnected = true;
			if (this.subscriberConnected === true) {
				this.emit("ready");
			}
		});

		this.client.on("end", () => {
			this.clientConnected = false;
			this.objectCache.clear();
		});

		this.client.on("error", (error: Error) => {
			this.clientConnected = false;
			this.objectCache.clear();
			this.emit("error", error, "client");
		});

		this.subscriber = this.client.duplicate();

		this.subscriber.on("ready", () => {
			this.subscriberConnected = true;
			if (this.clientConnected === true) {
				this.emit("ready");
			}
		});

		this.subscriber.on("end", () => {
			this.subscriberConnected = false;
			this.objectCache.clear();
		});

		this.subscriber.on("error", (error: Error) => {
			this.subscriberConnected = false;
			this.objectCache.clear();
			this.emit("error", error, "subscriber");
		});

		// set other attributes
		this.genKeyFromMsg = this.opts.genKeyFromMsg;
		this.valueTransformer = this.opts.valueTransformer;
		if (this.opts.additionalValueFetchMethod) {
			this.additionalValueFetchMethod = this.opts.additionalValueFetchMethod;
		}
		this.redisGetOpts = this.opts.redisGetOpts;
		if (this.opts.fetchOnMessage) {
			this.fetchOnMessage = true;
		}
		this.objectCache = new LRUCache<string, storedValueType>({
			max: this.opts.cacheMaxSize ?? 1000,
			fetchMethod: async (key: string) => {
				return await this.fetchMethode(key);
			}
		});
	}

	/**
	 * Connects both clients and subscriber.
	 * Also subscribes subscriber to the channel(s).
	 *
	 * @memberof RedisObjectCache
	 */
	public async connect() {
		if (this.clientConnected === false) {
			await this.client.connect();
		}

		if (this.subscriberConnected === false) {
			await this.subscriber.connect();
			if (this.opts.redisChannelOpts.type === "pSubscribe") {
				await this.subscriber.pSubscribe(this.opts.redisChannelOpts.name, async (message) => {
					await this.onMessage(message);
				});
			} else {
				await this.subscriber.subscribe(this.opts.redisChannelOpts.name, async (message) => {
					await this.onMessage(message);
				});

			}
		}
	}

	/**
	 * Funktion to get the value for the specific key.
	 * Uses the lru cache fetch function.
	 * Returns a copy of the Object if defined in the opts otherwise returns a reference.
	 * Returns undefined if no value was found.
	 * Can only be used if connected
	 *
	 * @param {string} key key you want to look up
	 * @param {GetOpts} opts options for getting values
	 * @memberof RedisObjectCache
	 */
	public async get(key: string, opts?: GetOpts) {
		if (!(this.clientConnected && this.subscriberConnected)) {
			throw new Error("DISCONNECTED");
		}

		try {
			const savedValue = await this.objectCache.fetch(key);

			if (opts?.clone) {
				const value = cloneDeep(savedValue);
				return value;
			}
			return savedValue;
		} catch (error) {
			this.handleError(error);
		}

		// eslint-disable-next-line consistent-return
		return;
	}

	/**
	 * Function that disconnects both client and subscriber.
	 *
	 * @memberof RedisObjectCache
	 */
	public async disconnect() {
		// is done without checking for client and subscriber connected because we want to keep option to disconnect when reconnects do not work
		if (this.subscriber.isOpen) {
			await this.subscriber.disconnect();
		}

		if (this.client.isOpen) {
			await this.client.disconnect();
		}

	}

	/**
	 * Funktion that calls quit function on both client and subscriber.
	 * Can only be called if clients are connected.
	 *
	 * @memberof RedisObjectCache
	 */
	public async quit() {
		if (!(this.clientConnected && this.subscriberConnected)) {
			throw new Error("DISCONNECTED");
		}

		await this.subscriber.quit();
		await this.client.quit();
	}

	/**
	 * Function that deletes a value from the cache and returns a boolean whether there was an entry in the cache or not
	 *
	 * @param key key you want to remove
	 * @memberof RedisValueCache
	 */
	public delete(key: string) {
		if (!(this.clientConnected && this.subscriberConnected)) {
			throw new Error("DISCONNECTED");
		}
		const wasInCache = this.objectCache.delete(key);
		return wasInCache;
	}

	/**
	 * Funktion to handle errors as defined in the opts.
	 *
	 * @private
	 * @param {unknown} error
	 * @memberof RedisObjectCache
	 */
	private handleError(error: unknown) {
		if (!this.opts.handleErrors || this.opts.handleErrors === "warn") {
			console.warn(error);
		} else if (this.opts.handleErrors === "throw") {
			throw error;
		} else if (this.opts.handleErrors === "emit") {
			this.emit("unexpectedError", error);
		}
	}

	/**
	 * function to handle the messages the subscriber receives
	 *
	 * @private
	 * @param {string} msg the message that was received
	 * @memberof RedisValueCache
	 */
	private async onMessage(msg: string) {
		try {
			const key = this.genKeyFromMsg(msg);
			if (key !== null && key !== undefined) {
				// delete key to be sure that if there are gets on the key in the meantime we only get the correct version
				this.objectCache.delete(key);
				// if for whatever reason client is disconnected but subscriber is not (should not happen) also check if key actually should be fetched
				if (this.clientConnected && this.fetchOnMessage) {
					await this.objectCache.fetch(key);
				}
			}
		} catch (error) {
			this.handleError(error);
		}
	}

	/**
	 * Function called in the lru cache fetch function.
	 * Contains main (complete) logic for fetching values.
	 *
	 * @private
	 * @param {string} key key to fetch
	 * @memberof RedisValueCache
	 */
	private async fetchMethode(key: string) {
		let redisValue: unknown;

		switch (this.redisGetOpts.type) {
			case "HGET": {
				redisValue = await this.client.HGET(key, this.redisGetOpts.argument);
				break;
			}
			case "GET": {
				redisValue = await this.client.GET(key);
				break;
			}
			case "HGETALL": {
				redisValue = await this.client.HGETALL(key);
				break;
			}
			default: {
				throw new Error("INVALID_FETCH_OPTIONS");
			}
		}

		let value = this.valueTransformer(redisValue);
		if (value === null || value === undefined) {
			if (this.additionalValueFetchMethod) {
				try {
					value = await this.additionalValueFetchMethod(key);
					if (value !== null && value !== undefined) {
						return value;
					}
				} catch (error) {
					this.handleError(error);
				}
			}
			// eslint-disable-next-line consistent-return
			return;
		}
		// eslint-disable-next-line consistent-return
		return value;
	}

	/**
	 * Functions that checks whether or not the opts provided are valid opts.
	 * Does not deeply check the client options and functions.
	 * Throws error if the opts are invalid.
	 *
	 * @private
	 * @param {unknown} opts
	 * @memberof RedisObjectCache
	 */
	private checkOpts(opts: unknown) {
		if (!opts) {
			throw new Error("OPTS_MISSING");
		}
		if (typeof opts !== "object") {
			throw new TypeError("OPTS_NOT_AN_OBJECT");
		}
		if ("cacheMaxSize" in opts && typeof opts.cacheMaxSize !== "number") {
			throw new TypeError("CACHE_MAX_SIZE_TYPE_MISMATCH");
		}
		if (!("redisChannelOpts" in opts) || !opts.redisChannelOpts) {
			throw new Error("REDIS_CHANNEL_OPTS_MISSING");
		}
		if (typeof opts.redisChannelOpts !== "object") {
			throw new TypeError("REDIS_CHANNEL_OPTS_TYPE_MISMATCH");
		}
		if (!(
			"type" in opts.redisChannelOpts
			&& "name" in opts.redisChannelOpts
			&& (opts.redisChannelOpts.type === "subscribe" || opts.redisChannelOpts.type === "pSubscribe")
			&& typeof opts.redisChannelOpts.name === "string"
		)) {
			throw new TypeError("REDIS_CHANNEL_OPTS_TYPE_INVALID");
		}
		if (!("redisClientOpts" in opts) || !opts.redisClientOpts) {
			throw new Error("REDIS_CLIENT_OPTS_MISSING");
		}
		if (typeof opts.redisClientOpts !== "object") {
			throw new TypeError("REDIS_CLIENT_OPTS_TYPE_MISMATCH");
		}
		if (!("redisGetOpts" in opts) || !opts.redisGetOpts) {
			throw new Error("FETCH_OPTIONS_MISSING");
		}
		if (typeof opts.redisGetOpts !== "object") {
			throw new TypeError("FETCH_OPTIONS_TYPE_MISMATCH");
		}
		if (!("type" in opts.redisGetOpts)
			|| !(opts.redisGetOpts.type === "HGET"
			|| opts.redisGetOpts.type === "HGETALL"
			|| opts.redisGetOpts.type === "GET")) {
			throw new Error("FETCH_OPTIONS_TYPE_INVALID");
		}

		if (opts.redisGetOpts.type === "HGET" && !("argument" in opts.redisGetOpts && typeof opts.redisGetOpts.argument === "string")) {
			throw new Error("FETCH_OPTIONS_ARGUMENT_INVALID");
		}

		if (!("genKeyFromMsg" in opts) || !opts.genKeyFromMsg) {
			throw new Error("GEN_KEY_FROM_MESSAGE_MISSING");
		}
		if (typeof opts.genKeyFromMsg !== "function") {
			throw new TypeError("GEN_KEY_FROM_MESSAGE_TYPE_MISMATCH");
		}
		if (!("valueTransformer" in opts) || !opts.valueTransformer) {
			throw new Error("REDIS_VALUE_TRANSFORMER_MISSING");
		}
		if (typeof opts.valueTransformer !== "function") {
			throw new TypeError("REDIS_VALUE_TRANSFORMER_TYPE_MISMATCH");
		}
		if (
			"handleErrors" in opts
			&& !(opts.handleErrors === "emit" || opts.handleErrors === "warn" || opts.handleErrors === "ignore" || opts.handleErrors === "throw")
		) {
			throw new Error("HANDLE_ERRORS_INVALID");
		}
		if ("additionalValueFetchMethod" in opts && typeof opts.additionalValueFetchMethod !== "function") {
			throw new Error("ADDITIONAL_VALUE_FETCH_METHOD_INVALID");
		}
		if ("fetchOnMessage" in opts && typeof opts.fetchOnMessage !== "boolean") {
			throw new Error("FETCH_ON_MESSAGE_INVALID");
		}
	}
}
