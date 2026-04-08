import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandOutput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DynamoDBItem,
  DynamoDBKeys,
  DynamoDBQuery,
  DynamoDBQueryOptions,
  DynamoDBReadOptions,
  DynamoDBUpdateOptions,
} from '../interfaces/dynamodb.interface';
import {Logger} from './logger.class';
import {DateTime} from 'luxon';

// import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
export const isOffline = (): boolean => process.env.IS_OFFLINE === 'true';

export class DynamoDBBaseModel {
  readonly tableName: string;
  protected logger: Logger;
  private client: DynamoDBDocumentClient;

  constructor(client: DynamoDBDocumentClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
    this.logger = new Logger();
  }

  static getConfigurations(options?: any) {
    if (isOffline()) {
      return {
        credentials: {
          accessKeyId: 'DEFAULTACCESSKEY', // needed if you don't have aws credentials at all in env,
          secretAccessKey: 'DEFAULTSECRET', // needed if you don't have aws credentials at all in env
        },
        region: 'localhost',
        endpoint: 'http://localhost:8000',
      };
    }

    return options || {};
  }

  getClient() {
    return this.client;
  }

  async create(item: DynamoDBItem, options?: any) {
    this.logger.debug('[CREATE] Starting create operation', {PK: item?.PK, SK: item?.SK});
    const createdAt = DateTime.now().toUTC().toISO();
    const newItem = {
      ...item,
      createdAt: createdAt,
      updatedAt: createdAt,
    };

    // In case of options destructure the options here, and used inside PutCommand
    const {ConditionExpression} = options || {};

    const command = new PutCommand({
      TableName: this.tableName,
      Item: newItem,
      ConditionExpression,
    });

    const results = await this.client.send(command);
    this.logger.info('[CREATE] Item inserted');
    return results;
  }

  async read(key: DynamoDBItem, options?: DynamoDBReadOptions) {
    this.logger.debug('[READ] Starting read operation', {PK: key?.PK, SK: key?.SK});

    const {ProjectionExpression: processProjectionExpression, ConsistentRead} = options || {};
    const {ProjectionExpression, ExpressionAttributeNames} = this.processProjectionExpression(processProjectionExpression);

    const params = {
      TableName: this.tableName,
      Key: key,
      ProjectionExpression,
      ExpressionAttributeNames,
      ConsistentRead,
    };
    const command = new GetCommand(params);
    const results = await this.client.send(command);
    this.logger.info(`[READ] Items retrieved, total result:${results?.Item?.length}`);
    return results;
  }

  async update(updateItem: DynamoDBItem, options?: DynamoDBUpdateOptions) {
    this.logger.debug('[UPDATE] Starting update operation', {PK: updateItem?.PK, SK: updateItem?.SK});

    const {ConditionExpression, ReturnConsumedCapacity, ConditionalOperator} = options || {};
    const {keys: Key, item} = this.extractKeysAndItem(updateItem);

    item['updatedAt'] = DateTime.now().toUTC().toISO();

    const {UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues} = this.buildUpdateParams(item);

    const command = new UpdateCommand({
      TableName: this.tableName,
      Key,
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ConditionalOperator,
      ReturnConsumedCapacity,
      ConditionExpression,
    });
    const results = await this.client.send(command);
    this.logger.info(`[UPDATE] Item updated`);
    return results;
  }

  async query(request: DynamoDBQuery, options?: DynamoDBQueryOptions) {
    this.logger.info('[QUERY] Starting query operation', {request});
    const {ExpressionAttributeNames, KeyConditionExpression, ExpressionAttributeValues} = request;

    const {
      FilterExpression,
      QueryFilter,
      ScanIndexForward,
      Limit,
      IndexName: IndexNameFromOptions,
      ProjectionExpression: processProjectionExpression,
    } = options || {};

    const {IndexName: IndexNameFromRequest} = request as any;

    const IndexName = IndexNameFromOptions || IndexNameFromRequest;

    const {ProjectionExpression, ExpressionAttributeNames: ProjectionExpressionAttributeNames} =
      this.processProjectionExpression(processProjectionExpression);

    let totalResults: any[] = [];
    let lastEvaluatedKey = undefined;
    let currentLimit = Limit;
    let totalConsumedCapacity = 0; // Variable to accumulate the consumed capacity
    let iteration = 1;

    do {
      const command: QueryCommand = new QueryCommand({
        TableName: this.tableName,
        IndexName,
        KeyConditionExpression,
        ExpressionAttributeValues,
        Limit: currentLimit,
        ScanIndexForward,
        QueryFilter,
        ExpressionAttributeNames: {...ExpressionAttributeNames, ...ProjectionExpressionAttributeNames},
        FilterExpression,
        ProjectionExpression,
        ExclusiveStartKey: lastEvaluatedKey, // Set the last evaluated key to handle pagination
        ReturnConsumedCapacity: 'TOTAL', // Include consumed capacity in the response
      });

      const results: QueryCommandOutput = await this.client.send(command);
      this.logger.debug('[QUERY] Query results', {result: !!results});

      if (results.Items) {
        totalResults = [...totalResults, ...results.Items]; // Accumulate all results
      }

      // Accumulate consumed capacity
      if (results.ConsumedCapacity) {
        totalConsumedCapacity += results.ConsumedCapacity.CapacityUnits || 0;
        this.logger.debug('[QUERY] ConsumedCapacity', {totalConsumedCapacity, iteration, currentLimit});
      }

      lastEvaluatedKey = results.LastEvaluatedKey; // Set the next token for the next iteration
      currentLimit = currentLimit ? currentLimit - (results.Items?.length || 0) : undefined; // Decrease limit if defined

      if (lastEvaluatedKey) {
        this.logger.debug('[QUERY] lastEvaluatedKey', {
          lastEvaluatedKey,
          iteration,
          currentLimit,
          Limit,
          totalItems: totalResults.length,
          totalConsumedCapacity,
        });
      }
      this.logger.debug('[QUERY] before while', {
        evaluateWhile: lastEvaluatedKey && (!Limit || (currentLimit && currentLimit > 0)),
        lastEvaluatedKey,
        iteration,
        currentLimit,
        Limit,
      });

      iteration += 1;
    } while (lastEvaluatedKey && (!Limit || (currentLimit && currentLimit > 0))); // Continue until no more results or limit reached

    this.logger.info(`[QUERY] All query results ,totalItems: ${totalResults.length}`);
    // Return all items; optionally, you can include LastEvaluatedKey for pagination
    return {
      Items: totalResults,
    };
  }

  async delete(key: DynamoDBItem, force: boolean = false) {
    this.logger.debug('[DELETE] Starting delete operation', {PK: key?.PK, SK: key?.SK});
    const deletedAt = DateTime.now().toUTC().toISO();

    if (force) {
      // Forced delete: permanently remove the item from the table
      const command = new DeleteCommand({
        TableName: this.tableName,
        Key: key,
      });
      const results = await this.client.send(command);
      this.logger.info('[DELETE] Item deleted permanently');
      return results;
    } else {
      // Soft delete: update the item with a deletedAt timestamp
      const updateRequest = {
        ...key,
        deletedAt,
      };
      return this.update(updateRequest);
    }
  }

  /**
   * Perform a batch get of items from DynamoDB.
   * Automatically handles:
   * - Chunking keys in groups of 100 (BatchGet limit)
   * - Retrying unprocessed keys until all are retrieved
   *
   * @param keys The array of keys to retrieve
   * @param options Optional read options (ProjectionExpression, ConsistentRead)
   * @returns Object containing all retrieved items: { Items: DynamoDBItem[] }
   */
  async batchGet(keys: DynamoDBItem[], options?: DynamoDBReadOptions): Promise<{Items: DynamoDBItem[]}> {
    this.logger.info(`[BATCH-GET] Starting batch get operation, number of elements: ${keys?.length}`);

    const {ProjectionExpression: processProjectionExpression, ConsistentRead} = options || {};
    const {ProjectionExpression, ExpressionAttributeNames} = this.processProjectionExpression(processProjectionExpression);

    // Helper to split the keys into groups of up to 100
    const chunkArray = (arr: DynamoDBItem[], size: number): DynamoDBItem[][] => {
      const chunks = [];
      for (let iChunk = 0; iChunk < arr.length; iChunk += size) {
        chunks.push(arr.slice(iChunk, iChunk + size));
      }
      return chunks;
    };

    // The final array of items retrieved
    let allResults: DynamoDBItem[] = [];

    // Split the original keys into chunks of 100
    const keyChunks = chunkArray(keys, 100);

    // Process each chunk
    for (const chunk of keyChunks) {
      // Keep track of unprocessed keys for retries
      let unprocessedKeys = chunk;
      do {
        const command = new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: unprocessedKeys,
              ConsistentRead,
              ProjectionExpression,
              ExpressionAttributeNames,
            },
          },
        });

        const response = await this.client.send(command);
        this.logger.info('[BATCH-GET] Response received');

        const tableResponse = response.Responses?.[this.tableName] || [];
        allResults = [...allResults, ...tableResponse];

        unprocessedKeys = response.UnprocessedKeys?.[this.tableName]?.Keys || [];

        if (unprocessedKeys.length) {
          this.logger.info(`[BATCH-GET] Retrying unprocessed keys , unprocessedKeysCount: ${unprocessedKeys.length}`);
        }
      } while (unprocessedKeys.length > 0);
    }

    this.logger.info(`[BATCH-GET] All items retrieved, total: ${allResults.length}`);
    return {Items: allResults};
  }

  // Helper methods
  buildUpdateParams(item: DynamoDBItem) {
    let UpdateExpression = 'set ';
    const ExpressionAttributeValues: {[key: string]: any} = {};
    const ExpressionAttributeNames: {[key: string]: string} = {};

    const itemKeys = Object.keys(item);
    itemKeys.forEach((key, index) => {
      const attributeValueKey = `:val${index}`;
      const attributeNameKey = `#attrName${index}`;

      UpdateExpression += `${attributeNameKey} = ${attributeValueKey}`;
      UpdateExpression += index < itemKeys.length - 1 ? ', ' : '';

      ExpressionAttributeValues[attributeValueKey] = item[key];
      ExpressionAttributeNames[attributeNameKey] = key;
    });

    return {UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames};
  }

  processProjectionExpression(projectionExpression: string | undefined) {
    if (!projectionExpression || projectionExpression === '') {
      return {ProjectionExpression: undefined, ExpressionAttributeNames: undefined};
    }

    const attributeNames = projectionExpression.split(',').map((attr) => attr.trim());
    const ExpressionAttributeNames: DynamoDBItem = {};
    let ProjectionExpression = '';

    attributeNames.forEach((attr, index) => {
      const placeholder = `#attr${index}`;
      ExpressionAttributeNames[placeholder] = attr;
      ProjectionExpression += `${placeholder}`;
      if (index < attributeNames.length - 1) {
        ProjectionExpression += ', ';
      }
    });

    return {ProjectionExpression, ExpressionAttributeNames};
  }

  extractKeysAndItem(item: DynamoDBItem): {keys: DynamoDBKeys; item: DynamoDBItem} {
    const keys: DynamoDBKeys = {};
    const attributes: {[key: string]: any} = {};

    Object.entries(item).forEach(([key, value]) => {
      if (key.toUpperCase() === 'PK' || key.toUpperCase() === 'SK') {
        // @ts-expect-error No idea why but
        keys[key] = value;
      } else {
        attributes[key] = value;
      }
    });

    return {keys, item: attributes};
  }
}
