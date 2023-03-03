import { sortBy, sumBy, uniq } from 'lodash'
import {
  batchedWaitAll,
  cancelBet,
  getAllBets,
  getAllMarkets,
  getFullMarket,
  placeBet,
} from './api'
import type { Bet, FullMarket } from './types'
const { Configuration, OpenAIApi } = require("openai");

const mode = true ? 'ADD_BETS' : 'RESET'

const main = async () => {
  const username = process.env.MANIFOLD_USERNAME
  const key = process.env.MANIFOLD_API_KEY
  if (!username) {
    throw new Error('Please set MANIFOLD_USERNAME variable in .env file.')
  }
  if (!key) {
    throw new Error('Please set MANIFOLD_API_KEY variable in .env file.')
  }
  const myBets = await getAllBets(username)
  const myContractIds = uniq(myBets.map((bet) => bet.contractId))

  console.log(
    'Got bets',
    myBets.length,
    'Contracts bet on',
    myContractIds.length
  )

  const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const openai = new OpenAIApi(configuration);

  if (mode === 'RESET') {
    await cancelLimitBets(myBets)
    await betOnTopMarkets(openai, [])
  } else {
    // Bet on new markets.
    await betOnTopMarkets(openai, myContractIds)
  }
}

const betOnTopMarkets = async (openai: typeof OpenAIApi, excludeContractIds: string[]) => {
  const markets = await getAllMarkets()
  console.log('Loaded', markets.length)

  let openBinaryMarkets = markets
    .filter((market) => market.outcomeType === 'BINARY')
    .filter(
      (market) =>
        !market.isResolved && market.closeTime && market.closeTime > Date.now()
    )
    .filter((market) => !excludeContractIds.includes(market.id))

  console.log('Open binary markets', openBinaryMarkets.length)
  openBinaryMarkets = openBinaryMarkets.sort(() => Number(Math.random() > 0.5));
  openBinaryMarkets = openBinaryMarkets.slice(0, 10);

  await batchedWaitAll(
    openBinaryMarkets.map((market) => async () => {
      const fullMarket = await getFullMarket(market.id)
      // if(!fullMarket.bets) return;
      // const marketBets = fullMarket.bets.filter(
      //   (bet) => bet.limitProb === undefined
      // )

      // if (marketBets.length >= 10) {
      //   // const bets = await placeLimitBets(fullMarket)
      //   if (bets.length)
      //     console.log('Placed orders for', fullMarket.question, ':', bets)
      // }
      const completion = await openai.createCompletion({
        model: "code-davinci-002",
        prompt: "Manibot is an accurate forecaster who can answer factual questions well.\n"
                + "Will Joe Biden win the presidential Election?\nA: YES\n"
                + "Will a nuclear weapon be detonated in 2022? (tests included)?\nA: NO\n"
                + fullMarket.question + "\nA:",
        logprobs: 5,
        max_tokens: 1
      });
      const probs = completion.data.choices[0].logprobs.top_logprobs[0];
      let n = probs[" NO"], y = probs[" YES"];
      console.log(probs)
      if(!n || !y) return;
      n = Math.exp(n), y = Math.exp(y);
      n = n / (n + y);
      const outcome = Math.random() < n ? "NO" : "YES";
      await placeBet({outcome, amount: 1, contractId: fullMarket.id });
    })
  )
}

const cancelLimitBets = async (bets: Bet[]) => {
  const openBets = bets.filter(
    (bet) => bet.limitProb !== undefined && !bet.isCancelled && !bet.isFilled
  )

  await Promise.all(openBets.map((bet) => cancelBet(bet.id)))
}

const placeLimitBets = async (market: FullMarket) => {
  const { bets, id } = market

  const sortedBets = sortBy(bets, (bet) => bet.createdTime)
  const marketBets = sortedBets.filter((bet) => bet.limitProb === undefined)

  const vol = sumBy(marketBets, (bet) => Math.abs(bet.amount))
  const logVol = Math.log(vol)
  const amount = 10 + logVol * 15

  const ranges = computeRanges(marketBets)
  const limitBets = ranges
    .map((range, i) => rangeToBets(range, amount * (i + 1)))
    .flat()

  await Promise.all(
    limitBets.map((bet) => placeBet({ ...bet, contractId: id }))
  )
  return limitBets
}

const computeRanges = (marketBets: Bet[]) => {
  const vol = sumBy(marketBets, (bet) => Math.abs(bet.amount))
  const logVol = Math.log(vol)
  const updateFactor = 0.1 + (0.2 * Math.max(0, 12 - logVol)) / 12

  if (marketBets.length <= 1) return []

  const lastPrice = marketBets[marketBets.length - 1].probAfter
  const prices = marketBets.map((bet) => ({
    price: lastPrice - bet.probAfter,
    amount: bet.amount,
  }))
  const { average, std } = movingAverageExp(prices, updateFactor)
  const downSpread = 2 * lastPrice * std
  const upSpread = 2 * std * (1 - lastPrice)
  const [low, high] = [
    lastPrice - downSpread + Math.min(average, 0),
    lastPrice + upSpread + Math.max(0, average),
  ]
  const [low2, high2] = [low - std, high + std]

  return [[low, high] as [number, number], [low2, high2] as [number, number]]
}

const rangeToBets = (range: [number, number], amount: number) => {
  const [low, high] = range
  if (
    isNaN(low) ||
    isNaN(high) ||
    low <= 0.001 ||
    high <= 0.001 ||
    low >= 0.999 ||
    high >= 0.999
  )
    return []

  const shares = Math.min(amount / low, amount / (1 - high))
  const yesAmount = shares * low
  const noAmount = shares * (1 - high)

  return [
    {
      outcome: 'YES' as const,
      amount: yesAmount,
      limitProb: low,
    },
    {
      outcome: 'NO' as const,
      amount: noAmount,
      limitProb: high,
    },
  ]
}

const movingAverageExp = (
  values: { price: number; amount: number }[],
  updateFactor = 0.2
) => {
  let average = values[0].price
  let variance = 0

  for (let i = 0; i < values.length; i++) {
    const { price, amount } = values[i]
    // Moving average where time is the amount bet.
    // I.e. amount / 100 is one unit of time.
    const a = 1 - (1 - updateFactor) ** (Math.abs(amount) / 100)

    average = average * (1 - a) + price * a
    variance = variance * (1 - a) + (price - average) ** 2 * a
  }
  const std = Math.sqrt(variance)
  return { average, variance, std }
}

if (require.main === module) {
  console.log('hello world!')
  main()
}
