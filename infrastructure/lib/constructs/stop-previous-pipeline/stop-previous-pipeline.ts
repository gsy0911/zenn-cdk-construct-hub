import {
  Stack,
  StackProps,
  aws_iam,
  aws_s3,
  aws_lambda,
  aws_events,
  aws_events_targets,
  aws_codebuild,
  aws_codepipeline,
  aws_codepipeline_actions,
  aws_codedeploy,
  aws_sns,
  aws_sns_subscriptions,
  SecretValue,
  aws_codestarnotifications,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
// import { environment, prefix } from "./types";

interface IBackendPipelineStack {
  /** サービス名の後ろに付与する場合、`-`で終わるとエラーが起きるため */
  environment: environment;
  source: {
    git: {
      /** git owner name */
      owner: string;
      /** git repository name */
      repositoryName: string;
      /** このブランチにマージされた時にデプロイパイプラインが走るようになる */
      branch: `feature/${string}` | "develop" | "main";
    };
    s3: {
      bucketName: string;
      /** CodeDeployで利用するTaskdefのファイル */
      bucketKeyBackendTaskdefFile: `backend_taskdef/taskdef.${environment}.json.zip`;
    };
  };
  secretManager: {
    /**
     * GitHubへアクセスするTokenを保管している SecretManagerのARN
     * stgとprodで共通
     * */
    gitTokenARN: "GitHub";
    /** mapping key name */
    gitTokenJsonField: "GitHubToken";
    slackTokenArn: "Slack";
    slackTokenJsonField: "BotUserOAuthToken";
  };
  codeBuild: {
    /**
     * CodeBuild実行時のbuildspecのファイル名
     * CodeBuildに付与している環境変数で、Dockerビルドとデプロイの内容を変更させているため
     * stgとprodは共通
     * */
    buildSpecFile: "buildspec.backend.yaml";
  };
  codeDeploy: {
    /**
     * CodeDeploy実行時のtaskdefのファイル名
     * taskdefはstgとprodで別れている必要がある
     * */
    taskDefinitionTemplateFile: `taskdef.${environment}.json`;
    /**
     * CodeDeploy実行時のappspecのファイル名
     * dev1とbetaは共通
     * */
    appSpecTemplateFile: "appspec.yaml";
    /** Slackに通知する際の表示名になるため、どちらの環境かを明示的にするためにstgとprodにしている */
    deploymentGroupName: environment;
  };
  ecs: {
    ecsClusterName: `stamprally-cluster-${environment}`;
    ecsServiceName: `Service-${environment}`;
  };
  /**
   * Dockerのビルド時のパラメータ
   * ビルドするDockerfileを切り替える
   */
  buildTarget: environment;
  slack: {
    configurationArn: `arn:aws:chatbot::377234633259:chat-configuration/slack-channel/paak-${environment}`;
    channelId: `C${string}`;
  };
}

export const devBackendPipelineParams: IBackendPipelineStack = {
  environment: "dev",
  source: {
    git: {
      owner: "paaaak",
      repositoryName: "uji_stamprally",
      branch: "feature/#486",
    },
    s3: {
      bucketName: "paaaak-raund-cicd-dev",
      bucketKeyBackendTaskdefFile: "backend_taskdef/taskdef.dev.json.zip",
    },
  },
  secretManager: {
    gitTokenARN: "GitHub",
    gitTokenJsonField: "GitHubToken",
    slackTokenArn: "Slack",
    slackTokenJsonField: "BotUserOAuthToken",
  },
  codeBuild: {
    buildSpecFile: "buildspec.backend.yaml",
  },
  codeDeploy: {
    taskDefinitionTemplateFile: "taskdef.dev.json",
    appSpecTemplateFile: "appspec.yaml",
    deploymentGroupName: "dev",
  },
  buildTarget: "dev",
  ecs: {
    ecsClusterName: "stamprally-cluster-dev",
    ecsServiceName: "Service-dev",
  },
  slack: {
    configurationArn:
      "arn:aws:chatbot::377234633259:chat-configuration/slack-channel/paak-dev",
    channelId: "C0437SGBZEV",
  },
};

export class StopPreviousPipeline extends Construct {
  constructor(
    scope: Construct,
    id: string,
    params: IBackendPipelineStack,
  ) {
    super(scope, id);

    const accountId = Stack.of(this).account;
    const region = Stack.of(this).region;

    /** Lambdaに付与するロール */
    const lambdaRole = new aws_iam.Role(this, "envfiles", {
      roleName: `pipelineBackendRole-${params.environment}`,
      assumedBy: new aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaCloudWatchFullAccess",
          "arn:aws:iam::aws:policy/AWSOpsWorksCloudWatchLogs",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaAutoScaling",
          "arn:aws:iam::aws:policy/AutoScalingFullAccess",
        ),
      ],
      inlinePolicies: {
        policies: new aws_iam.PolicyDocument({
          statements: [
            new aws_iam.PolicyStatement({
              effect: aws_iam.Effect.ALLOW,
              resources: ["*"],
              actions: [
                "application-autoscaling:DescribeScalableTargets",
                "application-autoscaling:RegisterScalableTarget",
                "codepipeline:*",
              ],
            }),
          ],
        }),
      },
    });

    /** GitHubからソースコードを取得する */
    const githubSourceOutput = new aws_codepipeline.Artifact(
      `github-artifact-${accountId}`,
    );
    const oauth = SecretValue.secretsManager(params.secretManager.gitTokenARN, {
      jsonField: params.secretManager.gitTokenJsonField,
    });
    const githubSourceAction = new aws_codepipeline_actions.GitHubSourceAction({
      actionName: "GitHubSource",
      owner: params.source.git.owner,
      repo: params.source.git.repositoryName,
      oauthToken: oauth,
      output: githubSourceOutput,
      branch: params.source.git.branch,
      trigger: aws_codepipeline_actions.GitHubTrigger.NONE,
    });

    /**
     * taskdef.jsonを取得するためにS3を利用している。
     * taskdef.jsonにDatabaseの接続情報を記述する必要があったため。
     * */
    const s3SourceOutput = new aws_codepipeline.Artifact(
      `s3-artifact-${accountId}`,
    );
    const s3SourceAction = new aws_codepipeline_actions.S3SourceAction({
      actionName: "backend-taskdef-from-s3",
      bucket: aws_s3.Bucket.fromBucketName(
        this,
        "sourceBucket",
        params.source.s3.bucketName,
      ),
      bucketKey: params.source.s3.bucketKeyBackendTaskdefFile,
      output: s3SourceOutput,
      trigger: aws_codepipeline_actions.S3Trigger.NONE,
    });

    /** 直前のpipelineを停止するLambda */
    const lambdaStopPreviousExecution = new PythonFunction(
      this,
      "lambdaStopPreviousPipelineExecution",
      {
        functionName: `lambdaStopPreviousBackendPipelineExecution-${params.environment}`,
        entry: "./lib/lambda/fargate_pipeline_stack",
        index: "stop_previous_pipeline_execution.py",
        handler: "handler",
        runtime: aws_lambda.Runtime.PYTHON_3_11,
        environment: {
          PIPELINE_NAME: `${prefix}-backend-${params.environment}`,
        },
        role: lambdaRole,
      },
    );

    const stopPreviousExecutionAction =
      new aws_codepipeline_actions.LambdaInvokeAction({
        actionName: "stopPreviousExecution",
        lambda: lambdaStopPreviousExecution,
        runOrder: 1,
      });

    /**
     * ビルドのstageに行く前に承認のアクションを設ける
     */
    const approvalAction = new aws_codepipeline_actions.ManualApprovalAction({
      actionName: "deployApprovalAction",
      runOrder: 1,
    });

    /**
     * Build action
     */
    const buildRole = new aws_iam.Role(this, "buildRole", {
      roleName: `build-backend-${params.environment}`,
      assumedBy: new aws_iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "buildECRAccess",
          "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess",
        ),
        /** Policy to access SecretsManager: dockerhub へのパスワードなどを取得するため */
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "buildSecretsManagerAccess",
          "arn:aws:iam::aws:policy/SecretsManagerReadWrite",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "buildCloudWatchFullAccess",
          "arn:aws:iam::aws:policy/AWSOpsWorksCloudWatchLogs",
        ),
      ],
    });

    // to build docker in CodeBuild, set privileged True
    const codeBuildCache = aws_codebuild.Cache.local(
      aws_codebuild.LocalCacheMode.DOCKER_LAYER,
    );
    const project = new aws_codebuild.PipelineProject(this, "DockerBuild", {
      projectName: `docker-build-project-${params.environment}`,
      environment: {
        // node.js 14を利用するために
        // see: https://docs.aws.amazon.com/ja_jp/codebuild/latest/userguide/build-env-ref-available.html
        buildImage: aws_codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      buildSpec: aws_codebuild.BuildSpec.fromSourceFilename(
        params.codeBuild.buildSpecFile,
      ),
      cache: codeBuildCache,
      environmentVariables: {
        AWS_ACCOUNT: {
          type: aws_codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: accountId,
        },
        AWS_REGION: {
          type: aws_codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: region,
        },
        BUILD_TARGET: {
          type: aws_codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: params.buildTarget,
        },
      },
      role: buildRole,
    });

    const codeBuildOutput = new aws_codepipeline.Artifact(
      `codebuild-artifact-${accountId}`,
    );
    const buildAction = new aws_codepipeline_actions.CodeBuildAction({
      actionName: "CodeBuild",
      project: project,
      input: githubSourceOutput, // The build action must use the CodeCommitSourceAction output as input.
      extraInputs: [],
      outputs: [codeBuildOutput], // optional
      runOrder: 1,
    });

    const deployApplication = new aws_codedeploy.EcsApplication(
      this,
      "deployApplication",
      {
        // ここもslackに通知されるのでわかりやすく
        applicationName: `raund-app-${params.environment}`,
      },
    );

    /**
     * Currently, deployment group is not automatically created.
     * You should create deployment group after `$ cdk deploy`
     */
    const deploymentGroup =
      aws_codedeploy.EcsDeploymentGroup.fromEcsDeploymentGroupAttributes(
        this,
        "deploymentGroup",
        {
          application: deployApplication,
          deploymentGroupName: params.codeDeploy.deploymentGroupName,
          deploymentConfig: aws_codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
        },
      );

    /**
     * DeployActionRole
     * see: https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/codedeploy_IAM_role.html
     */
    new aws_iam.Role(this, "deployActionRole", {
      roleName: `deployActionRole-${params.environment}`,
      assumedBy: new aws_iam.ServicePrincipal("codedeploy.amazonaws.com"),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "deployCloudWatchFullAccess",
          "arn:aws:iam::aws:policy/AWSOpsWorksCloudWatchLogs",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "deployS3FullAccess",
          "arn:aws:iam::aws:policy/AmazonS3FullAccess",
        ),
      ],
      inlinePolicies: {
        policies: new aws_iam.PolicyDocument({
          statements: [
            new aws_iam.PolicyStatement({
              effect: aws_iam.Effect.ALLOW,
              resources: ["*"],
              actions: [
                "ecs:DescribeServices",
                "ecs:CreateTaskSet",
                "ecs:UpdateServicePrimaryTaskSet",
                "ecs:DeleteTaskSet",
                "elasticloadbalancing:DescribeTargetGroups",
                "elasticloadbalancing:DescribeListeners",
                "elasticloadbalancing:ModifyListener",
                "elasticloadbalancing:DescribeRules",
                "elasticloadbalancing:ModifyRule",
                "lambda:InvokeFunction",
                "cloudwatch:DescribeAlarms",
                "sns:Publish",
                "codedeploy:Get*",
                "codedeploy:RegisterApplicationRevision",
                "kms:Decrypt",
                "kms:DescribeKey",
              ],
            }),
            new aws_iam.PolicyStatement({
              effect: aws_iam.Effect.ALLOW,
              resources: ["*"],
              actions: ["iam:PassRole"],
              conditions: {
                StringLike: {
                  "iam:PassedToService": "ecs-tasks.amazonaws.com",
                },
              },
            }),
          ],
        }),
      },
    });

    const deployAction = new aws_codepipeline_actions.CodeDeployEcsDeployAction(
      {
        actionName: "CodeDeploy",
        deploymentGroup: deploymentGroup,
        taskDefinitionTemplateFile: s3SourceOutput.atPath(
          params.codeDeploy.taskDefinitionTemplateFile,
        ),
        appSpecTemplateFile: codeBuildOutput.atPath(
          params.codeDeploy.appSpecTemplateFile,
        ),
        runOrder: 2,
      },
    );

    /** ECSのオートスケーリングを停止するLambda */
    const lambdaStopEcsAutoScaling = new PythonFunction(
      this,
      "lambdaHooksEcsFargateBeforeInstall",
      {
        functionName: `lambdaHooksEcsFargateBeforeInstall-${params.environment}`,
        entry: "./lib/lambda/fargate_pipeline_stack",
        index: "deploy_hooks.py",
        handler: "before_install",
        runtime: aws_lambda.Runtime.PYTHON_3_11,
        environment: {
          ECS_CLUSTER_NAME: params.ecs.ecsClusterName,
          ECS_SERVICE_NAME: params.ecs.ecsServiceName,
        },
        role: lambdaRole,
      },
    );

    const stopEcsAutoScalingAction =
      new aws_codepipeline_actions.LambdaInvokeAction({
        actionName: "stopEcsAutoScaling",
        lambda: lambdaStopEcsAutoScaling,
        runOrder: 1,
      });

    /** ECSのオートスケーリングを再開するLambda */
    const lambdaReStartEcsAutoScaling = new PythonFunction(
      this,
      "lambdaHooksEcsFargateAfterInstall",
      {
        functionName: `lambdaHooksEcsFargateAfterInstall-${params.environment}`,
        entry: "./lib/lambda/fargate_pipeline_stack",
        index: "deploy_hooks.py",
        handler: "after_install",
        runtime: aws_lambda.Runtime.PYTHON_3_11,
        environment: {
          ECS_CLUSTER_NAME: params.ecs.ecsClusterName,
          ECS_SERVICE_NAME: params.ecs.ecsServiceName,
        },
        role: lambdaRole,
      },
    );
    const restartEcsAutoScalingAction =
      new aws_codepipeline_actions.LambdaInvokeAction({
        actionName: "restartEcsAutoScaling",
        lambda: lambdaReStartEcsAutoScaling,
        runOrder: 3,
      });

    const pipeline = new aws_codepipeline.Pipeline(this, "DeployPipeline", {
      pipelineName: `${prefix}-backend-${params.environment}`,
      artifactBucket: aws_s3.Bucket.fromBucketName(
        this,
        "sourcePipelineBucket",
        params.source.s3.bucketName,
      ),
      stages: [
        {
          stageName: "Source",
          actions: [githubSourceAction, s3SourceAction],
        },
        {
          stageName: "StopPreviousExecution",
          actions: [stopPreviousExecutionAction],
        },
        {
          stageName: "BuildAndDeployApproval",
          actions: [approvalAction],
        },
        {
          stageName: "BuildAndDeploy",
          actions: [buildAction],
        },
        {
          stageName: "DeployEcs",
          actions: [
            stopEcsAutoScalingAction,
            deployAction,
            restartEcsAutoScalingAction,
          ],
        },
      ],
    });

    const approvalTopic = new aws_sns.Topic(this, "approval-topic", {
      topicName: `${prefix}-backend-pipeline-approval-topic-${params.environment}`,
    });
    // slackのtokenをSecretsManagerから取得する
    const slackToken = SecretValue.secretsManager(
      params.secretManager.slackTokenArn,
      {
        jsonField: params.secretManager.slackTokenJsonField,
      },
    );
    /**
     * CodePipelineの承認を通知するLambda
     * 結果を受け取る処理は`ChatOpsStack`に作成している。
     * （すでにAPI Gatewayなども構築されているため）
     * */
    const lambdaSendManualApproval = new PythonFunction(
      this,
      "lambdaSendManualApproval",
      {
        functionName: `lambdaSendManualApproval-${params.environment}`,
        entry: "./lib/lambda/fargate_pipeline_stack",
        index: "send_manual_approval.py",
        handler: "lambda_handler",
        runtime: aws_lambda.Runtime.PYTHON_3_11,
        environment: {
          SLACK_API_TOKEN: slackToken.unsafeUnwrap(),
          CHANNEL_ID: params.slack.channelId,
          CODEPIPELINE_NAME: pipeline.pipelineName,
          TZ: "Asia/Tokyo",
        },
        role: lambdaRole,
      },
    );
    approvalTopic.addSubscription(
      new aws_sns_subscriptions.LambdaSubscription(lambdaSendManualApproval),
    );
    pipeline.notifyOnAnyManualApprovalStateChange(
      "notify-approval-topic",
      approvalTopic,
      {
        notificationRuleName: `${prefix}-backend-pipeline-approval-notification-${params.environment}`,
      },
    );

    /** event bridgeに、developかmainのブランチにpushがあった場合に実行するように設定 */
    new aws_events.Rule(this, "pipelineTriggerEvent", {
      ruleName: `backend-pipeline-trigger-event-${params.environment}`,
      eventPattern: {
        // 任意の値
        source: ["raund.github.actions"],
        // 任意の値
        detailType: ["backend"],
        detail: {
          "git-branch": [`refs/heads/${params.source.git.branch}`],
        },
      },
      targets: [new aws_events_targets.CodePipeline(pipeline)],
    });

    new aws_codestarnotifications.CfnNotificationRule(
      this,
      "codePipelineNotification",
      {
        name: `RaundCodeBackendPipeline-${params.environment}`,
        detailType: "FULL",
        eventTypeIds: [
          // 意図して中止した場合には通知しない
          "codepipeline-pipeline-pipeline-execution-succeeded",
          "codepipeline-pipeline-pipeline-execution-failed",
          "codepipeline-pipeline-pipeline-execution-started",
          // 承認の通知
          "codepipeline-pipeline-manual-approval-needed",
        ],
        resource: pipeline.pipelineArn,
        targets: [
          {
            targetType: "AWSChatbotSlack",
            targetAddress: params.slack.configurationArn,
          },
        ],
      },
    );

    new aws_codestarnotifications.CfnNotificationRule(
      this,
      "codeBuildNotification",
      {
        name: `RaundCodeBackendBuild-${params.environment}`,
        detailType: "FULL",
        eventTypeIds: [
          // CodeBuildは失敗した時のみ通知
          "codebuild-project-build-state-failed",
        ],
        resource: project.projectArn,
        targets: [
          {
            targetType: "AWSChatbotSlack",
            targetAddress: params.slack.configurationArn,
          },
        ],
      },
    );
  }
}
