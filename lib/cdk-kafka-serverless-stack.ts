import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import {
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { LambdaDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnServerlessCluster } from "aws-cdk-lib/aws-msk";
import { Construct } from "constructs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class CdkKafkaServerlessStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const { region, account } = this;

    /**
     * Kafka Serverless Cluster
     */
    const vpc = new Vpc(this, "VPC");
    const kafkaCluster = new CfnServerlessCluster(this, "MyServerlessCluster", {
      clusterName: "MyServerlessClusterPrivate",
      clientAuthentication: {
        sasl: {
          iam: {
            enabled: true,
          },
        },
      },
      vpcConfigs: [
        {
          subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
          securityGroups: [vpc.vpcDefaultSecurityGroup],
        },
      ],
    });

    /**
     * Client Policy
     */
    const clientPolicy = new Policy(this, "ClientPolicy", {
      statements: [
        new PolicyStatement({
          actions: [
            "kafka-cluster:Connect",
            "kafka-cluster:AlterCluster",
            "kafka-cluster:DescribeCluster",
            "kafka-cluster:DescribeClusterV2",
          ],
          resources: [
            `arn:aws:kafka:${region}:${account}:cluster/${kafkaCluster.clusterName}/*`,
          ],
        }),
        new PolicyStatement({
          actions: ["kafka:GetBootstrapBrokers", "kafka:DescribeClusterV2"],
          resources: [
            `arn:aws:kafka:${region}:${account}:cluster/${kafkaCluster.clusterName}/*`,
          ],
        }),

        new PolicyStatement({
          actions: [
            "kafka-cluster:*Topic*",
            "kafka-cluster:WriteData",
            "kafka-cluster:ReadData",
          ],
          resources: [
            `arn:aws:kafka:${region}:${account}:topic/${kafkaCluster.clusterName}/*`,
          ],
        }),
        new PolicyStatement({
          actions: ["kafka-cluster:AlterGroup", "kafka-cluster:DescribeGroup"],
          resources: [
            `arn:aws:kafka:${region}:${account}:group/${kafkaCluster.clusterName}/*`,
          ],
        }),
      ],
    });
    const role = new Role(this, "ClientRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    clientPolicy.attachToRole(role);

    /**
     * Producer
     */
    const lambda = new NodejsFunction(this, "Producer", {
      entry: "lib/producer.ts",
      runtime: Runtime.NODEJS_16_X,
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [
        SecurityGroup.fromSecurityGroupId(
          this,
          "defaultSg",
          vpc.vpcDefaultSecurityGroup
        ),
      ],
      environment: {
        MSK_CLUSTER_ARN: kafkaCluster.attrArn,
      },
    });
    clientPolicy.attachToRole(lambda.role!);

    const rule = new Rule(this, "ProducerRule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(lambda), new LambdaFunction(lambda, {})],
    });
    /**
     * Consumer
     */
    const consumerLambda = new NodejsFunction(this, "Consumer", {
      entry: "lib/consumer.ts",
      runtime: Runtime.NODEJS_16_X,
    });
    clientPolicy.attachToRole(consumerLambda.role!);
    consumerLambda.role?.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyArn(
        this,
        "MSKExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaMSKExecutionRole"
      )
    );

    consumerLambda.addEventSourceMapping("EventSourceMapping", {
      eventSourceArn: kafkaCluster.attrArn,
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      enabled: true,
      kafkaTopic: "test-topic",
    });
  }
}
