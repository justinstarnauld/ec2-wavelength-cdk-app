import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';

require('dotenv').config();

const config = {
  env: {
    account: process.env.AWS_ACCOUNT_NUMBER,
    region: process.env.AWS_REGION,
  },
};

// Wavelength zones based on region availability
const wavelengthAZ: string = 'us-west-2-wl1-sfo-wlz-1';

export class WlEc2Stack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    // add env config
    super(scope, id, { ...props, env: config.env });

    // create new IAM role
    const role = new iam.Role(this, 'wlz-ec2-demo-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // create vpc
    const vpc = new ec2.Vpc(this, 'AppVPC', {
      cidr: '10.0.0.0/16',
      maxAzs: 1,
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'Public',
          cidrMask: 24,
        },
        {
          subnetType: ec2.SubnetType.PRIVATE,
          name: 'Private',
          cidrMask: 24,
        },
      ],
    });

    // create carrier gateway
    const cagw = new ec2.CfnCarrierGateway(this, 'wlz-ec2-cagw', {
      vpcId: vpc.vpcId,
    });

    // create WLZ private subnet
    const wlPrivateSubnet = new ec2.PrivateSubnet(this, 'wlz-private-subnet', {
      availabilityZone: wavelengthAZ,
      cidrBlock: '10.0.2.0/26',
      vpcId: vpc.vpcId,
      mapPublicIpOnLaunch: false,
    });

    // add WLZ subnet to VPC privateSubnets[]
    vpc.privateSubnets.push(wlPrivateSubnet);

    // assoicate carrier gateway to route table
    new ec2.CfnRoute(this, 'wlz-route', {
      destinationCidrBlock: '0.0.0.0/0',
      routeTableId: wlPrivateSubnet.routeTable.routeTableId,
      carrierGatewayId: cagw.ref,
    });

    // create security group
    const securityGroup = new ec2.SecurityGroup(this, 'wlz-sg', {
      vpc: vpc,
      allowAllOutbound: true,
      securityGroupName: 'wlz-sg',
    });

    // upate security group rules allow inbound traffic on specific ports
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allows SSH access from bastion'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5000),
      'Allows HTTP access from carrier network'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.icmpPing(),
      'Allows ICMP pings from carrier devices'
    );

    // create instance profile from IAM role
    const instanceProfile = new iam.CfnInstanceProfile(
      this,
      'wlz-instance-profile',
      {
        roles: [role.roleName],
      }
    );

    // define instance image
    const image = new ec2.AmazonLinuxImage();

    // create cfn launch template
    const wlLaunchTemplate = new ec2.CfnLaunchTemplate(
      this,
      'wl-launch-template',
      {
        launchTemplateName: 'wl-launch-template',
        launchTemplateData: {
          networkInterfaces: [
            {
              deviceIndex: 0,
              associateCarrierIpAddress: true,
              groups: [securityGroup.securityGroupId],
              deleteOnTermination: true,
              subnetId: wlPrivateSubnet.subnetId!,
            },
          ],
          imageId: image.getImage(this).imageId,
          instanceType: 't3.medium',
          keyName: 'wl-cdk-demo-1', // <= make sure to create a new EC2 KeyPair to enable SSH access
          iamInstanceProfile: { arn: instanceProfile.attrArn },
        },
      }
    );

    // create cfn instance
    const wlEc2Instance = new ec2.CfnInstance(this, 'wlz-ec2-instance', {
      launchTemplate: {
        launchTemplateName: wlLaunchTemplate.launchTemplateName,
        version: wlLaunchTemplate.attrDefaultVersionNumber,
      },
      availabilityZone: wavelengthAZ,
    });

    // Output public DNS attr (carrier IP) from wlz ec2 instance
    new cdk.CfnOutput(this, `wlz-instance-publicDNS:`, {
      value: wlEc2Instance.attrPublicDnsName,
    });
  }
}

const app = new cdk.App();
new WlEc2Stack(app, 'WlEc2Stack', {});
app.synth();
