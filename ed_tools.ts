import { dynamicApiRequest } from "./services/apiService";
import { RequestContext } from "./services/chatPlannerService";
import { runSelectQuery } from "./services/dataService";
import { searchPokemon } from "./services/pokemonService";
import { findTopKSimilarApi } from "./services/taskSelectorService";
import { watchlistAdd, watchlistList, watchlistRemove } from "./services/watchlistService";
import { clarifyAndRefineUserInput } from "./utils/queryRefinement";

export const apiService = async (input: any) => {
    const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
    return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken);
};
export const queryRefinement = async (input: any) => {
    const typedInput = input as { userInput: string; userToken?: string };
    return await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken);
};
export const dataService = async (input: any) => {
    const typedInput = input as { query: string };
    return await runSelectQuery(typedInput.query);
};
export const pokemonService = async (input: any) => {
    return await searchPokemon(input);
};
export const taskSelectorService = async (input: any) => {
    const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
    return await findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
};
export const watchlistService = async (input: any) => {
    const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
    if (action === 'add') return await watchlistAdd(payload, userToken);
    if (action === 'remove') return await watchlistRemove(payload, userToken);
    return await watchlistList(userToken);
};