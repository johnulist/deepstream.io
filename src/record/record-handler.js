'use strict'

const C = require('../constants/constants')
const SubscriptionRegistry = require('../utils/subscription-registry')
const ListenerRegistry = require('../listen/listener-registry')
const RecordRequest = require('./record-request')
const RecordTransition = require('./record-transition')
const RecordDeletion = require('./record-deletion')
const messageBuilder = require('../message/message-builder')

const writeSuccess = JSON.stringify({ writeSuccess: true })

/**
 * The entry point for record related operations
 *
 * @param {Object} options deepstream options
 */
const RecordHandler = function (options) {
  this._options = options
  this._subscriptionRegistry = new SubscriptionRegistry(options, C.TOPIC.RECORD)
  this._listenerRegistry = new ListenerRegistry(C.TOPIC.RECORD, options, this._subscriptionRegistry)
  this._subscriptionRegistry.setSubscriptionListener(this._listenerRegistry)
  this._transitions = {}
  this._recordRequestsInProgress = {}
}

/**
 * Handles incoming record requests.
 *
 * Please note that neither CREATE nor READ is supported as a
 * client send action. Instead the client sends CREATEORREAD
 * and deepstream works which one it will be
 *
 * @param   {SocketWrapper} socketWrapper the sender
 * @param   {Object} message parsed and validated deepstream message
 *
 * @public
 * @returns {void}
 */
RecordHandler.prototype.handle = function (socketWrapper, message) {
  /*
   * All messages have to provide at least the name of the record they relate to
   * or a pattern in case of listen
   */
  if (!message.data || message.data.length < 1) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.raw)
    return
  }

  if (message.action === C.ACTIONS.CREATEORREAD) {
    /*
     * Return the record's contents and subscribes for future updates.
     * Creates the record if it doesn't exist
     */
    this._createOrRead(socketWrapper, message)
  } else if (message.action === C.ACTIONS.CREATEANDUPDATE) {
    /*
     * Allows updates to the record without being subscribed, creates
     * the record if it doesn't exist
     */
    this._createAndUpdate(socketWrapper, message)
  } else if (message.action === C.ACTIONS.SNAPSHOT) {
    /*
     * Return the current state of the record in cache or db
     */
    this._snapshot(socketWrapper, message)
  } else if (message.action === C.ACTIONS.HEAD) {
    /*
     * Return the current state of the record in cache or db
     */
    this._head(socketWrapper, message)
  } else if (message.action === C.ACTIONS.HAS) {
    /*
     * Return a Boolean to indicate if record exists in cache or database
     */
    this._hasRecord(socketWrapper, message)
  } else if (message.action === C.ACTIONS.UPDATE || message.action === C.ACTIONS.PATCH) {
    /*
     * Handle complete (UPDATE) or partial (PATCH) updates
     */
    this._update(socketWrapper, message)
  } else if (message.action === C.ACTIONS.DELETE) {
    /*
     * Deletes the record
     */
    this._delete(socketWrapper, message)
  } else if (message.action === C.ACTIONS.UNSUBSCRIBE) {
  /*
   * Unsubscribes (discards) a record that was previously subscribed to
   * using read()
   */
    this._subscriptionRegistry.unsubscribe(message.data[0], socketWrapper)
  } else if (message.action === C.ACTIONS.LISTEN ||
  /*
   * Listen to requests for a particular record or records
   * whose names match a pattern
   */
    message.action === C.ACTIONS.UNLISTEN ||
    message.action === C.ACTIONS.LISTEN_ACCEPT ||
    message.action === C.ACTIONS.LISTEN_REJECT ||
    message.action === C.ACTIONS.LISTEN_SNAPSHOT) {
    this._listenerRegistry.handle(socketWrapper, message)
  } else {
  /*
   * Default for invalid messages
   */
    this._options.logger.log(C.LOG_LEVEL.WARN, C.EVENT.UNKNOWN_ACTION, message.action)

    if (socketWrapper !== C.SOURCE_MESSAGE_CONNECTOR) {
      socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.UNKNOWN_ACTION, `unknown action ${message.action}`)
    }
  }
}

/**
 * Tries to retrieve the record from the cache or storage. If not found in either
 * returns false, otherwise returns true.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._hasRecord = function (socketWrapper, message) {
  const recordName = message.data[0]

  const onComplete = function (record) {
    const hasRecord = record ? C.TYPES.TRUE : C.TYPES.FALSE
    socketWrapper.sendMessage(C.TOPIC.RECORD, C.ACTIONS.HAS, [recordName, hasRecord])
  }
  const onError = function (error) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.ACTIONS.HAS, [recordName, error])
  }

  // eslint-disable-next-line
  new RecordRequest(recordName,
    this._options,
    socketWrapper,
    onComplete.bind(this),
    onError.bind(this)
  )
}

/**
 * Sends the records data current data once loaded from the cache, and null otherwise
 *
 * @param {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @private
 * @returns {void}
 */
RecordHandler.prototype._snapshot = function (socketWrapper, message) {
  const recordName = message.data[0]

  const onComplete = function (record) {
    if (record) {
      this._sendRecord(recordName, record, socketWrapper)
    } else {
      socketWrapper.sendError(
        C.TOPIC.RECORD,
        C.ACTIONS.SNAPSHOT,
        [recordName, C.EVENT.RECORD_NOT_FOUND]
      )
    }
  }
  const onError = function (error) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.ACTIONS.SNAPSHOT, [recordName, error])
  }

  // eslint-disable-next-line
  new RecordRequest(
    recordName,
    this._options,
    socketWrapper,
    onComplete.bind(this),
    onError.bind(this)
  )
}

/**
 * Similar to snapshot, but will only return the current version number
 *
 * @param {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @private
 * @returns {void}
 */
RecordHandler.prototype._head = function (socketWrapper, message) {
  const recordName = message.data[0]

  const onComplete = function (record) {
    if (record) {
      socketWrapper.sendMessage(C.TOPIC.RECORD, C.ACTIONS.HEAD, [recordName, record._v])
    } else {
      socketWrapper.sendError(
        C.TOPIC.RECORD,
        C.ACTIONS.HEAD,
        [recordName, C.EVENT.RECORD_NOT_FOUND]
      )
    }
  }
  const onError = function (error) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.ACTIONS.HEAD, [recordName, error])
  }

  // eslint-disable-next-line
  new RecordRequest(
    recordName,
    this._options,
    socketWrapper,
    onComplete.bind(this),
    onError.bind(this)
  )
}


/**
 * Tries to retrieve the record and creates it if it doesn't exist. Please
 * note that create also triggers a read once done
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._createOrRead = function (socketWrapper, message) {
  const recordName = message.data[0]

  const onComplete = function (record) {
    if (record) {
      this._read(recordName, record, socketWrapper)
    } else {
      this._permissionAction(
        C.ACTIONS.CREATE,
        recordName,
        socketWrapper,
        this._create.bind(this, recordName, socketWrapper)
      )
    }
  }

  // eslint-disable-next-line
  new RecordRequest(
    recordName,
    this._options,
    socketWrapper,
    onComplete.bind(this)
  )
}

/**
 * An upsert operation where the record will be created and written to
 * with the data in the message. Important to note that each operation,
 * the create and the write are permissioned separately.
 *
 * This method also takes note of the storageHotPathPatterns option, when a record
 * with a name that matches one of the storageHotPathPatterns is written to with
 * the CREATEANDUPDATE action, it will be permissioned for both CREATE and UPDATE, then
 * inserted into the cache and storage.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._createAndUpdate = function (socketWrapper, message) {
  if (message.data.length < 4) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.data[0])
    return
  }

  const recordName = message.data[0]
  const isPatch = message.data.length === 5
  message.action = isPatch ? C.ACTIONS.PATCH : C.ACTIONS.UPDATE

  // allow writes on the hot path to bypass the record transition
  // and be written directly to cache and storage
  for (let i = 0; i < this._options.storageHotPathPatterns.length; i++) {
    const pattern = this._options.storageHotPathPatterns[i]
    if (recordName.indexOf(pattern) !== -1 && !isPatch) {
      this._permissionAction(C.ACTIONS.CREATE, recordName, socketWrapper, () => {
        this._permissionAction(C.ACTIONS.UPDATE, recordName, socketWrapper, () => {
          this._forceWrite(recordName, message, socketWrapper)
        })
      })
      return
    } else if (isPatch) {
      socketWrapper.sendError(
        C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, 'unable to patch record data on hot path'
      )
      return
    }
  }

  const transition = this._transitions[recordName]
  if (transition) {
    this._permissionAction(message.action, recordName, socketWrapper, () => {
      transition.add(socketWrapper, message)
    })
    return
  }

  this._permissionAction(C.ACTIONS.CREATE, recordName, socketWrapper, () => {
    this._permissionAction(C.ACTIONS.UPDATE, recordName, socketWrapper, () => {
      this._update(socketWrapper, message, true)
    })
  })
}

/**
 * Forcibly writes to the cache and storage layers without going via
 * the RecordTransition. Usually updates and patches will go via the
 * transition which handles write acknowledgements, however in the
 * case of a hot path write acknowledgement we need to handle that
 * case here.
 *
 * @param  {String} recordName the name of the record being updated
 * @param  {Object} message the update message
 * @param  {SocketWrapper} socketWrapper the socket that sent the request
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._forceWrite = function (recordName, message, socketWrapper) {
  const storageData = `{ "__ds": { "_v": 0 }, ${message.data[2]} }`
  const cacheData = `{ "_v": 0, "_d": ${message.data[2]}`
  const writeAck = message.data[message.data.length - 1] === writeSuccess
  let cacheResponse = false
  let storageResponse = false
  let writeError
  this._options.storage.set(recordName, storageData, (error) => {
    if (writeAck) {
      storageResponse = true
      writeError = writeError || error || null
      this._handleForceWriteAcknowledgement(
        socketWrapper, message, cacheResponse, storageResponse, writeError
      )
    }
  })

  this._options.cache.set(recordName, cacheData, (error) => {
    if (!error) {
      this._$broadcastUpdate(recordName, message, false, socketWrapper)
    }
    if (writeAck) {
      cacheResponse = true
      writeError = writeError || error || null
      this._handleForceWriteAcknowledgement(
        socketWrapper, message, cacheResponse, storageResponse, writeError
      )
    }
  })
}

/**
 * Handles write acknowledgements during a force write. Usually
 * this case is handled via the record transition.
 *
 * @param  {SocketWrapper} socketWrapper the socket that sent the request
 * @param  {Object} message the update message
 * @param  {Boolean} cacheResponse flag indicating whether the cache has been set
 * @param  {Boolean} storageResponse flag indicating whether the storage layer
 *                                   has been set
 * @param  {String} error any errors that occurred during writing to cache
 *                        and storage
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._handleForceWriteAcknowledgement = function
  (socketWrapper, message, cacheResponse, storageResponse, error) {
  if (storageResponse && cacheResponse) {
    socketWrapper.sendMessage(C.TOPIC.RECORD, C.ACTIONS.WRITE_ACKNOWLEDGEMENT, [
      message.data[0],
      [message.data[1]],
      messageBuilder.typed(error)
    ], true)
  }
}

/**
 * Creates a new, empty record and triggers a read operation once done
 *
 * @param   {String} recordName the name of the record to create
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Function} callback optional callback that is fired when record
 *                              is set in cache
 * @private
 * @returns {void}
 */
RecordHandler.prototype._create = function (recordName, socketWrapper, callback) {
  const record = {
    _v: 0,
    _d: {}
  }

  // store the records data in the cache and wait for the result
  this._options.cache.set(recordName, record, (error) => {
    if (error) {
      this._options.logger.log(C.LOG_LEVEL.ERROR, C.EVENT.RECORD_CREATE_ERROR, recordName)
      socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.RECORD_CREATE_ERROR, recordName)
    } else if (callback) {
      callback(recordName, socketWrapper)
    } else {
      this._read(recordName, record, socketWrapper)
    }
  })

  if (!this._options.storageExclusion || !this._options.storageExclusion.test(recordName)) {
    // store the record data in the persistant storage independently and don't wait for the result
    this._options.storage.set(recordName, record, (error) => {
      if (error) {
        this._options.logger.log(C.LOG_LEVEL.ERROR, C.EVENT.RECORD_CREATE_ERROR, `storage:${error}`)
      }
    })
  }
}

/**
 * Subscribes to updates for a record and sends its current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._read = function (recordName, record, socketWrapper) {
  this._permissionAction(C.ACTIONS.READ, recordName, socketWrapper, () => {
    this._subscriptionRegistry.subscribe(recordName, socketWrapper)
    this._sendRecord(recordName, record, socketWrapper)
  })
}

/**
 * Sends the records data current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._sendRecord = function (recordName, record, socketWrapper) {
  socketWrapper.sendMessage(C.TOPIC.RECORD, C.ACTIONS.READ, [recordName, record._v, record._d])
}

 /**
 * Applies both full and partial updates. Creates a new record transition that will live as
 * long as updates are in flight and new updates come in
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @param   {Boolean} upsert whether an upsert is possible
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._update = function (socketWrapper, message, upsert) {
  const dataLength = message.data.length
  if (
    (message.action === C.ACTIONS.UPDATE && (dataLength !== 4 && dataLength !== 3)) ||
    (message.action === C.ACTIONS.PATCH && (dataLength !== 5 && dataLength !== 4))
  ) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.data)
    return
  }

  const recordName = message.data[0]
  const version = message.data[1] * 1 // https://jsperf.com/number-vs-parseint-vs-plus/3

  /*
   * If the update message is received from the message bus, rather than from a client,
   * assume that the original deepstream node has already updated the record in cache and
   * storage and only broadcast the message to subscribers
   */
  if (socketWrapper === C.SOURCE_MESSAGE_CONNECTOR) {
    this._$broadcastUpdate(recordName, message, false, socketWrapper)
    return
  }

  if (isNaN(version)) {
    socketWrapper.sendError(C.TOPIC.RECORD, C.EVENT.INVALID_VERSION, [recordName, version])
    return
  }

  let transition = this._transitions[recordName]
  if (transition && transition.hasVersion(version)) {
    transition.sendVersionExists({ message, version, sender: socketWrapper })
    return
  }

  if (!transition) {
    transition = new RecordTransition(recordName, this._options, this)
    this._transitions[recordName] = transition
  }

  transition.add(socketWrapper, version, message, upsert)
}

/**
 * Invoked by RecordTransition. Notifies local subscribers and other deepstream
 * instances of record updates
 *
 * @param   {String} name           record name
 * @param   {Object} message        parsed and validated deepstream message
 * @param   {Boolean} noDelay       Flag as to wether event allows delay
 * @param   {SocketWrapper} originalSender the socket the update message was received from
 *
 * @package private
 * @returns {void}
 */
RecordHandler.prototype._$broadcastUpdate = function (name, message, noDelay, originalSender) {
  this._subscriptionRegistry.sendToSubscribers(name, message, noDelay, originalSender)

  if (originalSender !== C.SOURCE_MESSAGE_CONNECTOR) {
    this._options.messageConnector.publish(C.TOPIC.RECORD, message)
  }
}

/**
 * Called by a RecordTransition, either if it is complete or if an error occured. Removes
 * the transition from the registry
 *
 * @todo  refactor - this is a bit of a mess
 * @param   {String} recordName record name
 *
 * @package private
 * @returns {void}
 */
RecordHandler.prototype._$transitionComplete = function (recordName) {
  delete this._transitions[recordName]
}

/**
 * Executes or schedules a callback function once all transitions are complete
 *
 * This is called from the PermissionHandler destroy method, which
 * could occur in cases where 'runWhenRecordStable' is never called,
 * such as when no cross referencing or data loading is used.
 *
 * @param   {String}   recordName the name of the record
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype.removeRecordRequest = function (recordName) {
  if (!this._recordRequestsInProgress[recordName]) {
    return
  }

  if (this._recordRequestsInProgress[recordName].length === 0) {
    delete this._recordRequestsInProgress[recordName]
    return
  }

  const callback = this._recordRequestsInProgress[recordName].splice(0, 1)[0]
  callback(recordName)
}

/**
 * Executes or schedules a callback function once all record requests are removed.
 * This is critical to block reads until writes have occured for a record, which is
 * only from permissions when a rule is required to be run and the cache has not
 * verified it has the latest version
 *
 * @param   {String}   recordName the name of the record
 * @param   {Function} callback   function to be executed once all writes to this record
 *                                are complete
 *
 * @public
 * @returns {void}
 */
RecordHandler.prototype.runWhenRecordStable = function (recordName, callback) {
  if (
    !this._recordRequestsInProgress[recordName] ||
    this._recordRequestsInProgress[recordName].length === 0
  ) {
    this._recordRequestsInProgress[recordName] = []
    callback(recordName)
  } else {
    this._recordRequestsInProgress[recordName].push(callback)
  }
}

/**
 * Deletes a record. If a transition is in progress it will be stopped. Once the
 * deletion is complete, an Ack is returned.
 *
 * If the deletion message is received from the message bus, rather than from a client,
 * we assume that the original deepstream node has already deleted the record from cache and
 * storage and we only need to broadcast the message to subscribers
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._delete = function (socketWrapper, message) {
  const recordName = message.data[0]

  if (this._transitions[recordName]) {
    this._transitions[recordName].destroy()
    delete this._transitions[recordName]
  }

  if (socketWrapper === C.SOURCE_MESSAGE_CONNECTOR) {
    this._onDeleted(recordName, message, socketWrapper)
  } else {
    // eslint-disable-next-line
    new RecordDeletion(this._options, socketWrapper, message, this._onDeleted.bind(this))
  }
}

/*
 * Callback for completed deletions. Notifies subscribers of the delete and unsubscribes them
 *
 * @param   {String} name           record name
 * @param   {Object} message        parsed and validated deepstream message
 * @param   {SocketWrapper} originalSender the socket the update message was received from
 *
 * @package private
 * @returns {void}
 */
RecordHandler.prototype._onDeleted = function (name, message, originalSender) {
  this._$broadcastUpdate(name, message, true, originalSender)

  for (const subscriber of this._subscriptionRegistry.getLocalSubscribers(name)) {
    this._subscriptionRegistry.unsubscribe(name, subscriber, true)
  }
}

/*
 * Callback for complete permissions. Notifies socket if permission has failed
 */
RecordHandler.prototype._onPermissionResponse = function (
  socketWrapper, message, successCallback, error, canPerformAction
) {
  if (error !== null) {
    socketWrapper.sendError(message.topic, C.EVENT.MESSAGE_PERMISSION_ERROR, error.toString())
  } else if (canPerformAction !== true) {
    socketWrapper.sendError(
      message.topic, C.EVENT.MESSAGE_DENIED, [message.data[0], message.action]
    )
  } else {
    successCallback()
  }
}

/**
 * A secondary permissioning step that is performed once we know if the record exists (READ)
 * or if it should be created (CREATE)
 *
 * @param   {String} action          One of C.ACTIONS, either C.ACTIONS.READ or C.ACTIONS.CREATE
 * @param   {String} recordName      The name of the record
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Function} successCallback A callback that will only be invoked if the operation was
 *                                     successful
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._permissionAction = function (
  action, recordName, socketWrapper, successCallback
  ) {
  const message = {
    topic: C.TOPIC.RECORD,
    action,
    data: [recordName]
  }

  this._options.permissionHandler.canPerformAction(
    socketWrapper.user,
    message,
    this._onPermissionResponse.bind(null, socketWrapper, message, successCallback),
    socketWrapper.authData
  )
}

module.exports = RecordHandler
