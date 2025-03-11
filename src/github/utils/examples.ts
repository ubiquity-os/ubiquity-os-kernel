import { VoyageAIClient } from "voyageai";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { EmbedRequestInputType } from "voyageai/api";

export interface Example {
  command: string;
  embedding: number[];
}

export async function initializeExamples(manifest: Manifest, voyageAiClient: VoyageAIClient): Promise<Example[]> {
  if (!manifest.commands) return [];

  const examplesFromManifest = Object.values(manifest.commands).flatMap((command) => command.examples?.map((example) => example.commandInvocation) ?? []);

  // Generate embeddings for all examples
  return await Promise.all(
    examplesFromManifest.map(async (command: string) => ({
      command,
      embedding: await generateEmbedding(voyageAiClient, command),
    }))
  );
}

async function generateEmbedding(voyageAiClient: VoyageAIClient, text: string, inputType: EmbedRequestInputType = "document"): Promise<number[]> {
  const response = await voyageAiClient.embed({
    input: text,
    model: "voyage-large-2-instruct",
    inputType,
  });
  return (response.data && response.data[0]?.embedding) || [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, curr, i) => sum + a[i] * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (normA * normB);
}

export async function findSimilarExamples(voyageAiClient: VoyageAIClient, input: string, count: number = 3, examples: Example[]): Promise<string[]> {
  const inputEmbedding = await generateEmbedding(voyageAiClient, input, "query");

  // Calculate similarities and sort
  const similarities = examples.map((example) => ({
    command: example.command,
    similarity: cosineSimilarity(inputEmbedding, example.embedding),
  }));

  return similarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, count)
    .map((result) => result.command);
}
