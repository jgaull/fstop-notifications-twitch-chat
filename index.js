require('dotenv').config()
const tmi = require('tmi.js')
const { gql, GraphQLClient, default: request } = require('graphql-request')
const base64 = require('base-64')
const axios = require('axios')

const usernameAndPassword = `${process.env.INTEGRATION_ID}:${process.env.INTEGRATION_KEY}`
const authorization = `Basic ${base64.encode(usernameAndPassword)}`
const graphQLClient = new GraphQLClient(process.env.INGEST_PATH, {
	headers: {
		Authorization: authorization,
	}
})

let activeIntegrations

async function loadIntegrations() {

	const query = gql`
		query Integrations($filter: FilterFindManyIntegrationInput) {
			integrations(filter: $filter) {
				user {
					_id
				}
				integrationSettings
				_id
			}
		}
	`

	const variables = {
		filter: {
			type: "twitch_chat"
		}
	}

	const response = await graphQLClient.request(query, variables)
	activeIntegrations = response.integrations.map(integration => {
		return {
			_id: integration._id,
			user: integration.user,
			integrationSettings: integration.integrationSettings
		}
	})

	const channelsToMonitor = activeIntegrations
	.map(integration => 
		integration.integrationSettings.channelName)
	.filter((channelName, index, channels) =>
		channels.indexOf(channelName) == index)

	const opts = {
		channels: channelsToMonitor
	}
	
	// Create a client with our options
	console.log(`connecting to twitch channels: [${opts.channels}]`)
	const client = new tmi.client(opts)

	// Register our event handlers (defined below)
	client.on('message', onMessageHandler)
	client.on('connected', onConnectedHandler)

	// Connect to Twitch:
	client.connect()
}

// Called every time the bot connects to Twitch chat
function onConnectedHandler (addr, port) {
	console.log(`* Connected to ${addr}:${port}`)
}

// Called every time a message comes in
async function onMessageHandler (target, context, message, self) {
	/*
	console.log('new chat message:')
	console.log(` target: ${JSON.stringify(target)}`)
	console.log(` context: ${JSON.stringify(context)}`)
	console.log(` msg: ${JSON.stringify(message)}`)
	console.log(` self: ${JSON.stringify(self)}`)
	*/

	const originatedAt = Date.now()

	const channelName = target.substring(1)

	let meta
	try {
		meta = await loadChannelMeta(channelName)
	}
	catch (error) {
		console.log(`error fetching chatters for ${channelName}: ${error.message}`)
	}

	const data = {
		context,
		meta
	}

	const query = gql`
	mutation CreateNotification($record: CreateOneNotificationInput!) {
		createNotification(record: $record) {
			recordId
		}
	}
	`

	const affectedIntegrations = activeIntegrations.filter(integration => {
		return integration.integrationSettings.channelName.toLowerCase() == channelName
	})

	const requests = affectedIntegrations.map(integration => {

		const variables = {
			record: {
				title: context['display-name'],
				type: "info",
				data: JSON.stringify(data),
				integration: integration._id,
				user: integration.user._id,
				originatedAt,
				message
			}
		}
		
		return graphQLClient.request(query, variables)
	})

	try {
		await Promise.all(requests)
		console.log(`success sending twitch chat message to ingest server!`)
	}
	catch (error) {
		console.log(`error sending notification from ${target} to the ingest server: ${error.stack}`)
	}
}

async function loadChannelMeta(channel) {

	const response = await axios.get(`http://tmi.twitch.tv/group/user/${channel}/chatters`)

	return {
		chatters: response.data
	}
}

loadIntegrations()