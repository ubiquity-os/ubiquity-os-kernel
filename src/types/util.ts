import { TAnySchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decompressString } from "@ubiquity-os/plugin-sdk/compression";

export function jsonType<TSchema extends TAnySchema>(type: TSchema, decompress = false) {
  return Type.Transform(Type.String())
    .Decode((value) => {
      const parsed = JSON.parse(decompress ? decompressString(value) : value);
      return Value.Decode<TSchema>(type, Value.Default(type, parsed));
    })
    .Encode((value) => JSON.stringify(value));
}
