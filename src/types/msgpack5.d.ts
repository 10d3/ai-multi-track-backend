declare module 'msgpack5' {
  function msgpack5(): {
    encode: (data: any) => Buffer;
    decode: (data: Buffer) => any;
  };
  export = msgpack5;
}