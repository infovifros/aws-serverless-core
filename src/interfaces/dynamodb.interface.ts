import {GetCommandInput, QueryCommandInput, UpdateCommandInput} from '@aws-sdk/lib-dynamodb';

// Custom utility type for omitting multiple properties
type OmitMultiple<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;

export interface PrimaryKey {
  PK: string;
  SK: string;
}

export interface GSI1Key extends PrimaryKey {
  GSI1PK: string;
  GSI1SK: string;
}

export interface GSI2Key extends GSI1Key {
  GSI2PK: string;
  GSI2SK: string;
}

export interface GSI3Key extends GSI2Key {
  GSI3PK: string;
  GSI3SK: string;
}

export interface GSI4Key extends GSI3Key {
  GSI4PK: string;
  GSI4SK: string;
}

export interface GSI5Key extends GSI4Key {
  GSI5PK: string;
  GSI5SK: string;
}

export interface BaseDynamoDbModel extends GSI5Key {
  entityType: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  expireAt?: number;
}

export interface DynamoDBQuery extends Omit<QueryCommandInput, 'TableName'> {
  // Add any additional custom properties if needed
}

export interface DynamoDBQueryOptions extends Omit<QueryCommandInput, 'TableName' | ''> {
  // Add any additional custom properties if needed
}

export interface DynamoDBUpdate {
  Item: DynamoDBItem;
}

export interface DynamoDBUpdateOptions
  extends OmitMultiple<
    UpdateCommandInput,
    'TableName' | 'Key' | 'UpdateExpression' | 'ExpressionAttributeValues' | 'ExpressionAttributeNames'
  > {}

export interface DynamoDBUpdate
  extends OmitMultiple<
    UpdateCommandInput,
    'TableName' | 'UpdateExpression' | 'ExpressionAttributeValues' | 'ExpressionAttributeNames'
  > {
  Item: DynamoDBItem;
}

export interface DynamoDBReadOptions extends OmitMultiple<GetCommandInput, 'TableName' | 'Key' | 'ExpressionAttributeNames'> {}

export interface DynamoDBItem {
  [key: string]: any; // Adjust as per your item structure
}

export interface DynamoDBKeys extends Partial<GSI5Key> {}
