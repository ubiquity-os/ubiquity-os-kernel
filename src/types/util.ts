import { Type, TAnySchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function jsonType<TSchema extends TAnySchema>(type: TSchema) {
  return Type.Transform(Type.String())
    .Decode((value) => {
      const parsed = JSON.parse(value);
      return Value.Decode<TSchema>(type, Value.Default(type, parsed));
    })
    .Encode((value) => JSON.stringify(value));
}
