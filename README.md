# Redis Value Cache

A module that fetches, caches, and updates your values from redis.

## Use Case

This module expects a Redis server where you store values and also have one or multiple channels where information on which keys to update is sent.

## Basics

* The module provides a class RedisValueCache.
* The class uses an LRU cache to store values.
* Keys must be the same Keys you use in redis.
* Values can be anything you want except `null` and `undefined`.
* The The constructor requires you to provide functions that change the data from redis the way you want it to be stored:
	* `genKeyFromMessage`: A function that takes a message sent over your channel and returns the key that needs to be updated.
	* `redisValueTransformer`: A function that takes a value fetched from redis and returns a value you would like to save instead (e.g. JSON.parse()).
* Please be sure to handle errors that can occur in these functions appropriately (e.g. there was no data found for the specified key in redis so the params are `undefined`).
* If these functions return `null` or `undefined`, the message/value will be ignored.
* The class uses a Redis client to subscribe to the channel you specify to listen for updates and a second redis-client to make the requests for the actual data.
* You need to connect both clients before you can start using the class.
* Values from redis will only be fetched if there is an update message or if you call the `get` function for a key that is not already stored in the Cache.

## Options

* `redisClientOpts`: Options for the node-redis client ([details](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md)). Used for both `subscriber` and `client`.
* `redisChannelOpts`: Options whether the `subscriber` should pSubscribe or subscribe normally.
* `redisGetOpts`: Options on how the data should be retrieved from redis. Supported options `GET`, `HGET` and `HGETALL`.
* `genKeyFromMsg`: Function that takes a message and returns a key that needs to get updated. The return must be a string.
* `valueTransformer`: Function that takes data retrieved from Redis and returns a value that should be saved in the cache.
* `cacheMaxSize` (Optional): Max number of objects to be stored in the LRU cache (Default = 1000).
* `handleErrors` (Optional): Options for how errors that happen when fetching data from redis should be handled.**Other errors will still be thrown disregarding this option**.
	* `"emit"`: Emits the error as an `"unexpectedError"` event.
	* `"warn"` (Default): Uses `console.warn()` to print the error.
	* `"throw"`: Throws the error.
	* `"ignore"`: Ignores the error.
* `additionalValueFetchMethod` (Optional): Function that should be used to fetch data if the data aws not found in redis.
* `fetchOnMessage` (Optional): Whether a key should be also fetched or just deleted when a message is received (Default = `false`).

## Usage (TypeScript)

### Basic Example

```ts
import { RedisValueCache } from "redis-value-cache";

const rvc = new RedisValueCache({
	redisClientOpts: {
		socket: {
			host: "localhost",
			port: 6379
		}
	},

	redisChannelOpts: {
		type: "subscribe",
		name: "channel-name"
	},

	redisGetOpts: {
		type: "GET"
	},
	
	cacheMaxSize: 5000,

	genKeyFromMsg: (msg: string) => {
		return msg;
	},
	
	valueTransformer: (redisValue: string| null) => {
		return redisValue;
	},
	handleErrors: "ignore"
})

await rvc.connect();

const x = await rvc.get("abc");

await rvc.quit();
```

### More Complex Example

```ts 
import { RedisValueCache } from "redis-value-cache";

interface msgType {
	id: number;
	info?: string;
}

// type of the objects you want to store
interface storedObjectType {
	type: "a" | "b";
	data: Record<string, unknown>;
}

const opts: Opts<storedObjectType> = {
	// client options for node-redis client
	redisClientOpts: {
		socket: {
			host: "localhost",
			port: 6379
		}
	},
	// options to subscribe / psubscribe
	redisChannelOpts: {
		type: "pSubscribe"
		name: "channel*",
	},
	// options to define how the client gets the data from redis
	redisGetOpts: {
		type: "HGET",
		argument: "info"
	},
	// maximum allowed number of objects to be stored in lru-cache
	cacheMaxSize: 5000,
	// function to extract key from message
	genKeyFromMsg: (msg: string) => {
		try{
			const msgObject = JSON.parse(msg) as msgType;

			// keys must be string and should be same as you use in redis
			return `key:${msg.id}`;
		} catch (error) {
			// custom error logic here
			
			// to tell cache to ignore message
			return null;
		}
	},
	// function to adjust redisValue to the way you want to store it
	// type of redisValue should change depending on the redisGetOpts
	valueTransformer: (redisValue: string | null) => {
		if(redisValue === null) {
			// key was not found in redis but you might like to log this or do something else

			return null;
		}
		try{
			const value = JSON.parse(redisValue) as storedObjectType;
			return value;
		} catch (error) {
			// custom error logic here
			
			// to tell cache to ignore message
			return null;
		} 
	},
	// how to deal with unexpected errors during fetch of data
	handleErrors: "emit",
	// function to get the value from a third source if the `valueTransformer` function returns null
	additionalValueFetchMethode: async(key: string) => {
		const resp = await fetch(`url/get/${key}`);
		const value = await resp.json() 
		return value as storedObjectType;
	}
}

// rvc emits all redis client error events as error events
rvc.on("error", (error, client: "subscriber" | "client") => {
	// your logic on how to handle error
});
// is emitted when the rvc is ready to use
rvc.on("ready", () => {
	// your logic here
	// will be emitted once during connect
	// can be useful for reconnection logic
});
// will emit errors in fetch functions if errorHandle option was set to emit
rvc.on("unexpectedError", (error) => {
	// your logic here
})

await rvc.connect();

const x = await rvc.get("key:1234",  { clone: true });

await rvc.quit();
```

## Emitted Events

| Name                    | When                                                                               | Listener arguments                                         |
|-------------------------|------------------------------------------------------------------------------------|------------------------------------------------------------|
| `ready`                 | RedisValueCache is ready to use                                                    | *No arguments*                                             |
| `error`                 | Either the `client` or the `subscriber` emitted an error event                     | `(error: Error, client: "subscriber" \| "client")`         |
| `unexpectedError`       | Something was thrown during a fetch attempt                                        | `(error: unknown)`                                         |


**!!Warning!!:** You **MUST** listen to `error` events. If a RedisValueCache doesn't have at least one `error` listener registered and an `error` event occurs, that error will be thrown and the Node.js process will exit. See the [`EventEmitter` docs](https://nodejs.org/api/events.html#events_error_events) for more details.

If an error event is emitted the RedisValueCache **flushes the cache** because it could miss messages.

## Functions

### .get()

This function retrieves values either from cache or Redis. Returns `undefined` if key could not be found.

Params: 

* `key` (string): Key of the value you want to look up.
* `opts` (object | Optional): Options for the get function.
	* `opts.clone` (boolean | Optional): Whether or not the value should be cloned before returning it.

#### Why Use The Clone Option?

If you do not use the clone option, the cache will return a reference to the stored object. This means if you make changes to the object later on it will also change what is stored in the cache.

If you are fine with that or know that you will not make any changes then do not use the clone option since this would be more efficient. Be aware that if an object gets updated because of a message the objected will be replaced with the version saved in redis and **this might not reflect your changes anymore**.

### .connect()

This function calls the `.connect()` function for both `subscriber` and `client` and also subscribes/pSubscribes the `subscriber` to the channel(s).

This function needs to be called in order to be able to use the RedisValueCache.

### .disconnect()

This function calls the `.disconnect()` function for both `subscriber` and `client`. This forcibly closes a client's connection to Redis immediately. This also flushes the cache.

### .quit()

This function calls the `.quit()` function for both  `subscriber` and `client`. This gracefully closes a client's connection to Redis. This also flushes the cache.

### .delete()

This function deletes a value from the cache. Returns `true` if value was in cache.

Params:

* `key` (string): Key of the value you want to delete.

This function should not be used to often but can be necessary to force a refresh for the value.

## Disconnects

If a disconnect, whether wanted or unwanted, occurs, the cache is flushed since it could miss potential change messages.

Both clients will try to reconnect to the server defined by your or the default reconnect strategy defined in the `redisClientOpts`.\
On a successful reconnect of both clients, a `"ready"` event will be emitted.

## Your Functions

For the functions you pass to the constructor there are the following things to keep in mind.

If a function returns `null` it will be seen as something went wrong.\
For the `genKeyFromMsg`, this means that nothing more can be done with this message.\
For the `valueTransformer`, this means that no value was found and the `additionalValueFetchMethod` will be used if it was provided.
For the `additionalValueFetchMethod`, this means that no value was found.

If you throw an error in these functions the error will be handled depending on the `handleErrors` options.\
Another option is to log/handle the error in your function and then just return `null`.
