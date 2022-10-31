# replicache-transaction

This is an adapter from Replicache's [WriteTransaction](https://doc.replicache.dev/api/interfaces/WriteTransaction) to some key/value storage.

It's useful when you want to reuse Replicache mutator functions on the backend. All you
have to do is provide a suitable implementation of the "Storage" interface, for example
against your backend SQL database and then execute each of the mutations in a
Replicache push request using them.

`ReplicacheTransaction` also implements an in-memory cache for entries over the lifetime
of the transaction so that repeated reads and writes for same key don't go back and forth
to the database.

## Usage

```ts
import mutators from "./my-mutators.ts";

class MyStorage implements Storage {
  // ...
}

const myStorage = new MyStorage(dbconn, spaceID, version);
const tx = new ReplicacheTransaction(storage, clientID);

const createTodo = mutators.createTodo;
await createTodo(tx, { title: "Hello, shared mutators", complete: false });

await tx.flush();
```

See [`replicache-express`](https://github.com/rocicorp/replicache-express/blob/main/src/backend/push.ts) for a complete example.

## Important: Sort Order

It is important that the `getEntries()` method returns keys in order of
their UTF-8 byte encoding. This is a collation option in most databases.
See https://blog.replicache.dev/blog/replicache-11-adventures-in-text-encoding
for more information.

## Contributing

PRs and feature requests are welcome!
