import { PrismaClient } from "@prisma/client";

const authorController = new PrismaClient();

interface ICreateUser {
  email: string;
  hashedPassword: string;
  Name: string;
}
// create user
export const createUser = async ({
  email,
  hashedPassword,
  Name,
}: ICreateUser) => {
  const user = await authorController.user.create({
    data: {
      email: email.toLowerCase(),
      name: Name,
      password: hashedPassword,
      token: "",
    },
  });
  return user;
};

// get user
export const getUser = async (email: string) => {
  const user = await authorController.user.findUnique({
    where: {
      email: email.toLowerCase(),
    },
  });
  return user;
};

//update user
export const updateUser = async (token: string, email: string) => {
  const user = await authorController.user.update({
    where: {
      email: email.toLowerCase(),
    },
    data: {
      token,
    },
  });
  return user;
}